// AI review of a pull request, for ai-review.yml. Subcommands, each reading env and files under OUT_DIR:
//   linear   fetch the Linear issue named in the branch or title (LINEAR_API_KEY) into linear.md
//   prepare  build prompt.md from the PR and its diff; sets `skip` when there is nothing to review or too much
//   run      run Claude Code read-only on prompt.md into claude.json
//   render   turn claude.json into the PR comment (`body`) and the number of high findings (`high`)
// A local calibration run calls the same subcommands, so it reviews with exactly what CI sends.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const here = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(env.OUT_DIR, name);
export const MARKER = '<!-- understory-ai-review -->';

function setOutput(name, value) {
  if (!env.GITHUB_OUTPUT) return console.log(`${name}=${value}`);
  const delim = `EOF_${crypto.randomBytes(8).toString('hex')}`;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delim}\n${value}\n${delim}\n`);
}

export function issueKeys(...texts) {
  const keys = new Set();
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]{2,6})-(\d{1,6})(?!\d)/g)) keys.add(`${m[1].toUpperCase()}-${m[2]}`);
  }
  return [...keys].slice(0, 2);
}

async function linear() {
  const found = [];
  for (const key of issueKeys(env.HEAD_REF, env.PR_TITLE)) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: env.LINEAR_API_KEY },
      body: JSON.stringify({ query: 'query($id:String!){issue(id:$id){identifier title description team{private}}}', variables: { id: key } }),
      signal: AbortSignal.timeout(15_000),
    });
    const issue = (await res.json().catch(() => null))?.data?.issue;
    // The author picks the key, so a private team's issue would otherwise leak into the comment.
    if (issue && !issue.team?.private) found.push(`### ${issue.identifier}: ${issue.title}\n\n${(issue.description ?? '').slice(0, 20_000)}`);
  }
  fs.writeFileSync(out('linear.md'), found.join('\n\n'));
  console.log(`linked Linear issues read: ${found.length}`);
}

const LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'uv.lock']);

export function buildPrompt({ repository, baseRef, title, body, issues, files, diff }) {
  // A tag the PR author can't guess, so their text can't close it and pose as ours.
  const tag = `untrusted-${crypto.randomBytes(6).toString('hex')}`;
  const block = (name, text) => `<${tag} name="${name}">\n${text}\n</${tag}>`;
  return [
    `Review this pull request in ${repository}. Your working directory is the PR merged into its base branch \`${baseRef}\`.`,
    'Title and description, written by the PR author:',
    block('pr', `# ${title}\n\n${String(body ?? '').slice(0, 20_000)}`),
    ...(issues ? ['The linked Linear issue, written by the team:', block('issue', issues)] : []),
    'Changed files, as +added -removed lines. Deleted, lock and generated files are left out of the diff below:',
    block('files', files),
    'The diff:',
    block('diff', diff),
    'Answer the four questions and list your findings, following your instructions.',
  ].join('\n\n');
}

function prepare() {
  const run = (args, opts = {}) => execFileSync('git', ['-C', env.REPO_DIR, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  const base = run(['rev-parse', env.BASE || 'HEAD^1']).trim();
  // Every diff reads .gitattributes from the base (git 2.40+), so the PR can't hide its code behind its own
  // `-diff`, `binary` or `linguist-generated`. Older git ignores the variable; CI's runners are newer.
  const git = (args, opts = {}) => run(args, { ...opts, env: { ...env, ...opts.env, GIT_ATTR_SOURCE: base } });
  // --no-ext-diff/--no-textconv: never run a diff driver that the PR's .gitattributes names.
  const range = ['--no-color', '--no-ext-diff', '--no-textconv', '-M', base, 'HEAD'];
  const deleted = new Set(git(['diff', '--name-only', '--diff-filter=D', ...range]).split('\n').filter(Boolean));
  const stats = git(['diff', '--numstat', ...range]).split('\n').filter(Boolean)
    .map((l) => { const [a, r, f] = l.split('\t'); return `+${a} -${r} ${f}${deleted.has(f) ? ' (deleted)' : ''}`; });

  // The diff leaves out deletions, lock files and what the *base* marks linguist-generated, read through a
  // scratch index: the PR's own .gitattributes could otherwise hide its code from the review.
  const tokens = git(['diff', '--name-status', '-z', '--diff-filter=d', ...range]).split('\0').filter(Boolean);
  const entries = []; // one per changed file: its path, or a rename's old and new path, which must be diffed together
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    entries.push(/^[RC]/.test(status) ? [tokens[i++], tokens[i++]] : [tokens[i++]]);
  }
  const index = { env: { ...env, GIT_INDEX_FILE: out('base.index') } };
  git(['read-tree', base], index);
  const attrs = entries.length ? git(['check-attr', '--cached', '-z', '--stdin', 'linguist-generated'], { ...index, input: entries.flat().join('\0') }).split('\0') : [];
  const generated = new Set();
  for (let i = 0; i + 2 < attrs.length; i += 3) if (['true', 'set'].includes(attrs[i + 2])) generated.add(attrs[i]);
  const skipped = (p) => generated.has(p) || LOCK_FILES.has(path.basename(p)) || p.endsWith('.snap');
  const keep = entries.filter((e) => !skipped(e.at(-1)));
  let diff = '';
  for (let i = 0; i < keep.length; i += 200) {
    diff += git(['diff', '--diff-filter=d', ...range, '--', ...keep.slice(i, i + 200).flat().map((p) => `:(literal)${p}`)]);
  }

  const kb = Math.ceil(Buffer.byteLength(diff) / 1024);
  const max = Number(env.MAX_DIFF_KB);
  console.log(`${stats.length} files changed, ${deleted.size} deleted, ${generated.size} generated, ${kb} KB of diff to review`);
  if (stats.length === 0) return setOutput('skip', 'the PR changes no files');
  if (kb > max) setOutput('oversize', 'true');
  if (kb > max) return setOutput('skip', `the diff is ${kb} KB, over the ${max} KB limit (deleted, lock and generated files don't count). Split the PR, or raise max_diff_kb`);
  const issues = fs.existsSync(out('linear.md')) ? fs.readFileSync(out('linear.md'), 'utf8').trim() : '';
  const files = stats.length > 500 ? [...stats.slice(0, 500), `… and ${stats.length - 500} more`].join('\n') : stats.join('\n');
  fs.writeFileSync(out('prompt.md'), buildPrompt({ repository: env.REPOSITORY, baseRef: env.BASE_REF, title: env.PR_TITLE, body: env.PR_BODY, issues, files, diff }));
  setOutput('skip', '');
}

const RESERVE_MS = 4 * 60_000;

function run() {
  const args = [
    '-p', '--output-format', 'json', '--no-session-persistence',
    // Only the file-reading tools, confined to the checkout (symlinks out of it are refused too);
    // no shell, web, MCP, settings, hooks or CLAUDE.md from the PR.
    '--restricted', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-prompts', 'none',
    '--model', env.MODEL, '--effort', env.EFFORT, '--max-turns', env.MAX_TURNS, '--max-budget-usd', env.MAX_BUDGET_USD,
    '--append-system-prompt-file', path.join(here, 'prompt.md'),
    '--json-schema', fs.readFileSync(path.join(here, 'schema.json'), 'utf8'),
  ];
  // JOB_DEADLINE (epoch seconds) is when the job times out. Claude Code stops RESERVE_MS before it, so the job
  // still renders and posts the comment; a job killed by its timeout would leave an older review standing.
  const timeout = env.JOB_DEADLINE ? Number(env.JOB_DEADLINE) * 1000 - Date.now() - RESERVE_MS : 15 * 60_000;
  if (!(timeout >= 60_000)) {
    fs.writeFileSync(out('claude.json'), JSON.stringify({ subtype: 'error_no_time' }));
    return console.log('no time left before the job times out: not running Claude Code');
  }
  // Only what Claude Code needs; nothing else from the runner's environment reaches it.
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'ANTHROPIC_API_KEY'].filter((k) => env[k]).map((k) => [k, env[k]]));
  // Files, not pipes: the grandchildren of a killed run can't keep this waiting on an open pipe.
  const r = spawnSync(env.CLAUDE_BIN || 'claude', args, {
    cwd: env.REPO_DIR, env: { ...childEnv, DISABLE_AUTOUPDATER: '1' }, killSignal: 'SIGKILL',
    stdio: [fs.openSync(out('prompt.md'), 'r'), fs.openSync(out('claude.json'), 'w'), fs.openSync(out('claude.err'), 'w')],
    timeout,
  });
  if (r.error?.code === 'ETIMEDOUT') fs.writeFileSync(out('claude.json'), JSON.stringify({ subtype: 'error_timeout' }));
  if (r.status !== 0) {
    // Indented, so no line of it is read as a workflow command.
    const err = redact(fs.readFileSync(out('claude.err'), 'utf8'), [env.ANTHROPIC_API_KEY]).slice(-2000).replace(/^/gm, '  ');
    console.log(`claude exited with ${r.status ?? r.signal ?? r.error?.code}:\n${err}`);
  }
}

// No markdown in the placeholder: `[redacted]` next to model text once made a link, image or reference definition.
export function redact(text, secrets = []) {
  for (const s of secrets) if (s && s.length >= 8) text = text.split(s).join('‹redacted›');
  return text.replace(/(sk-ant-|lin_api_|github_pat_|gh[pousr]_)[A-Za-z0-9_-]{8,}/g, '‹redacted›');
}
// Every string of the model's review, redacted before text() or code() sanitises it.
const redactAll = (v, secrets) => (typeof v === 'string' ? redact(v, secrets)
  : Array.isArray(v) ? v.map((x) => redactAll(x, secrets))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactAll(x, secrets)])) : v);

// Model text goes into a comment, where it must stay text: no HTML (so no fake marker), no entity that decodes
// to one, no @mention, link, image, autolinked URL, reference definition, issue reference (`#12`,
// `owner/repo#12`, `GH-12`), or code fence, which left open would swallow the rest of the comment.
// Redact before this, never after with anything that adds markdown.
export function text(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b')
    .replace(/!\[/g, '[').replace(/\]\s*[([:]/g, (m) => `${m[0]}\u200b${m.slice(1)}`)
    .replace(/:\/\//g, ':\u200b//').replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}\u200b.`)
    .replace(/#(?=\d)/g, '#\u200b').replace(/\bGH-(?=\d)/gi, (m) => `${m}\u200b`)
    .replace(/`{3,}|~{3,}/g, (m) => `\\${m}`);
}
const cell = (s) => text(s).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
// A path:line in a code span. Nothing but path characters, so it can't end the span or the line.
export const code = (s) => {
  const v = String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[^\w./:@\-[\]() +,=]/g, '');
  return v ? `\`${v}\`` : '';
};

export function renderBody(result, { blocking, sha, runUrl, model, secrets = [] }) {
  const review = redactAll(result?.structured_output, secrets);
  const tokens = Object.values(result?.modelUsage ?? {}).reduce(
    (t, u) => ({ in: t.in + (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0), out: t.out + (u.outputTokens ?? 0) }), { in: 0, out: 0 });
  const cost = result?.total_cost_usd != null ? ` · $${result.total_cost_usd.toFixed(2)}` : '';
  const footer = `<sub>Commit ${code(sha)} · ${model} · ${result?.num_turns ?? 0} turns · ${tokens.in} in / ${tokens.out} out tokens${cost} · [run](${runUrl}). Written by an AI with read-only access to the diff and the repository; it can be wrong.</sub>`;
  if (!review || !Array.isArray(review.findings)) {
    const why = {
      error_max_turns: 'it ran out of turns', error_max_budget_usd: 'it reached its cost limit',
      error_timeout: 'it ran out of time (timeout_minutes)', error_no_time: 'the job had no time left to run it (timeout_minutes)',
    }[result?.subtype] ?? 'it returned no review';
    return { high: 0, body: `${MARKER}\n### AI review didn't finish\n\nNo review for this commit: ${why}. This never blocks a merge.\n\n${footer}` };
  }
  const order = { high: 0, medium: 1, low: 2 };
  const findings = review.findings.filter((f) => f.severity in order).sort((a, b) => order[a.severity] - order[b.severity]);
  const count = (s) => findings.filter((f) => f.severity === s).length;
  const icon = { high: '🔴', medium: '🟠', low: '⚪' };
  const lines = [
    MARKER,
    `## AI review: ${count('high')} high · ${count('medium')} medium · ${count('low')} low`,
    text(review.summary),
    blocking ? '> A high finding fails this check.' : '> Advisory: this check never blocks a merge.',
  ];
  if (findings.length) {
    lines.push(['| Severity | Finding | Where |', '|---|---|---|', ...findings.map((f) => `| ${icon[f.severity]} ${f.severity} | ${cell(f.title)} | ${code(f.location)} |`)].join('\n'));
    lines.push(`<details><summary>Evidence</summary>\n\n${findings.map((f) => `**${cell(f.title)}** ${code(f.location)}\n\n${text(f.detail)}`).join('\n\n')}\n\n</details>`);
  }
  lines.push('### The four questions', ...[
    ['Which invariant changes', review.invariants], ['Which existing data it meets', review.existing_data],
    ['Blast radius', review.blast_radius], ['Which test proves it', review.proving_tests],
  ].map(([q, a]) => `**${q}:** ${text(a)}`), footer);
  let body = lines.join('\n\n');
  if (body.length > 60_000) body = `${body.slice(0, 59_000)}\n\n… cut to fit a comment.\n\n${footer}`;
  return { high: count('high'), body };
}

function render() {
  let result = null;
  try { result = JSON.parse(fs.readFileSync(out('claude.json'), 'utf8')); } catch { /* no output: rendered as unfinished */ }
  const secrets = [env.ANTHROPIC_API_KEY, env.LINEAR_API_KEY];
  const { body, high } = renderBody(result, { blocking: env.BLOCKING === 'true', sha: env.HEAD_SHA, runUrl: env.RUN_URL, model: env.MODEL, secrets });
  // A last pass over the whole body; it only swaps a token for the placeholder, which adds no markdown.
  setOutput('body', redact(body, secrets));
  setOutput('high', String(high));
  if (result) console.log(`turns ${result.num_turns}, cost $${result.total_cost_usd}, ${high} high`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = { linear, prepare, run, render }[process.argv[2]];
  if (!cmd) throw new Error('usage: review.mjs linear|prepare|run|render');
  await cmd();
}
