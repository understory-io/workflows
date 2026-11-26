// Runs the github-script step of tests-passed.yml against a mocked checks API
// and a fake clock: node test/tests-passed.mjs .github/workflows/tests-passed.yml
// The script is cut out of the YAML by its 12-space indent under `script: |`.

import fs from 'node:fs';
const wf = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const start = wf.findIndex((l) => l.trim() === 'script: |');
const body = [];
for (const l of wf.slice(start + 1)) { if (l.trim() && !l.startsWith('            ')) break; body.push(l.slice(12)); }
const src = body.join('\n');
const AsyncFunction = (async () => {}).constructor;

const RUNS = Symbol('runs'), CHECKS = Symbol('checks'), STATUSES = Symbol('statuses');
async function run(name, scenario, env = {}) {
  let clock = 1_000_000, poll = -1;
  const log = { failed: null, errors: [], notices: [], warnings: [], table: null, raw: '' };
  const github = {
    rest: {
      actions: { getWorkflowRun: async () => ({ data: { workflow_id: 99, check_suite_id: 999 } }), listWorkflowRunsForRepo: RUNS },
      checks: { listForRef: CHECKS }, repos: { listCommitStatusesForRef: STATUSES },
    },
    paginate: async (ep) => { if (ep === RUNS) poll++; const s = scenario(Math.max(poll, 0)); if (s.error) throw Object.assign(new Error(s.error.message), s.error); return ep === RUNS ? s.runs ?? [] : ep === CHECKS ? s.checks ?? [] : s.statuses ?? []; },
  };
  const summary = { addHeading() { return this; }, addRaw(t) { log.raw += t; return this; }, addTable(t) { log.table = t; return this; }, write: async () => {} };
  const core = { summary, info() {}, warning: (m) => log.warnings.push(m), error: (m) => log.errors.push(m), notice: (m) => log.notices.push(m), setFailed: (m) => { log.failed = m; } };
  const fakeSetTimeout = (fn, ms) => { clock += ms; fn(); };
  const FakeDate = { now: () => clock };
  Object.assign(process.env, { IGNORE: '', TIMEOUT_MINUTES: '45', SETTLE_SECONDS: '60', POLL_SECONDS: '30', SHA: 'abc', COUNT_COPILOT_REVIEW: 'false' }, env);
  const fn = new AsyncFunction('github', 'context', 'core', 'setTimeout', 'Date', src);
  try {
    await fn(github, { repo: { owner: 'o', repo: 'r' }, runId: 1 }, core, fakeSetTimeout, FakeDate);
  } catch (e) {
    log.failed = `threw: ${e.message}`;
  }
  return { ...log, polls: poll + 1, elapsed: (clock - 1_000_000) / 1000 };
}
const wrun = (id, wid, suite, extra = {}) => ({ id, workflow_id: wid, check_suite_id: suite, event: 'pull_request', path: `.github/workflows/wf${wid}.yml`, name: `wf${wid}`, run_attempt: 1, status: 'completed', conclusion: 'success', html_url: `u${id}`, ...extra });
const cr = (id, name, suite, status, conclusion, extra = {}) => ({ id, name, check_suite: { id: suite }, status, conclusion, app: { id: 15368, slug: 'github-actions' }, html_url: `c${id}`, ...extra });
// Dynamic runs as GitHub reports them (bookings run 45839052465 for Copilot).
const dyn = (id, wid, suite, path, name, extra = {}) => wrun(id, wid, suite, { event: 'dynamic', path, name, ...extra });
const copilot = (extra = {}) => dyn(8, 284823600, 80, 'dynamic/agents/copilot-pull-request-reviewer', 'Running Copilot Code Review', { conclusion: 'failure', ...extra });
const RETRY = 'After re-running the failed check, re-run this job (tests-passed) too.';
const self = [wrun(1, 99, 999, { status: 'in_progress', conclusion: null }), wrun(0, 99, 998, { conclusion: 'cancelled' })];
const selfChecks = [cr(1, 'tests-passed / tests-passed', 999, 'in_progress', null), cr(0, 'tests-passed / tests-passed', 998, 'completed', 'cancelled')];

let fails = 0;
const expect = (label, cond, r) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}  [polls=${r.polls} t=${r.elapsed}s failed=${JSON.stringify(r.failed)}]`); if (!cond) fails++; };

let r;
r = await run('A', () => ({ runs: self, checks: selfChecks }));
expect('A nothing else -> pass after settle, notice', r.failed === null && r.notices.length === 1 && r.elapsed >= 60 && r.elapsed < 120 && !r.raw.includes('re-run'), r);

r = await run('B', (p) => ({ runs: [...self, wrun(5, 1, 50, p < 3 ? { status: 'in_progress', conclusion: null } : {})], checks: [...selfChecks, cr(10, 'build / build', 50, p < 3 ? 'in_progress' : 'completed', p < 3 ? null : 'success')] }));
expect('B waits for running check then passes', r.failed === null && r.polls >= 5 && r.elapsed >= 150, r);

r = await run('C', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(11, 'build / binary', 50, 'completed', 'success')] }));
expect('C failure -> red, lists it', /1 of 2 checks did not pass: wf1 \/ build \/ build \(failure\)/.test(r.failed ?? ''), r);
expect('C red says to re-run the gate, in the error and the summary', (r.failed ?? '').endsWith(`(failure). ${RETRY}`) && r.raw.includes(RETRY), r);

r = await run('D', () => ({ runs: [...self, wrun(5, 1, 50, { run_attempt: 2 })], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(12, 'build / build', 50, 'completed', 'success')] }));
expect('D re-run job: newest counts', r.failed === null, r);

r = await run('E1', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' }), wrun(6, 1, 60)], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(13, 'build / build', 60, 'completed', 'success')] }));
expect('E1 newer run of same workflow+event wins', r.failed === null, r);

r = await run('E2', () => ({ runs: [...self, wrun(5, 1, 50, { event: 'push', conclusion: 'failure' }), wrun(6, 1, 60)], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(13, 'build / build', 60, 'completed', 'success')] }));
expect('E2 push run failure still counts', /did not pass/.test(r.failed ?? ''), r);

r = await run('F', () => ({ runs: self, checks: selfChecks, statuses: [{ id: 1, context: 'Vercel', state: 'pending', target_url: 'v' }] }), { TIMEOUT_MINUTES: '10' });
expect('F stuck status -> timeout message', /^timed out after 10 min; still running: Vercel \(pending\)/.test(r.failed ?? '') && r.elapsed <= 600 - 90 + 30, r);
expect('F timeout says to re-run the gate', (r.failed ?? '').endsWith('Once they finish, re-run this job (tests-passed).') && r.raw.includes('re-run this job'), r);

r = await run('G', () => ({ runs: [...self, wrun(7, 2, 70, { conclusion: 'startup_failure' })], checks: selfChecks }));
expect('G broken workflow file -> red', /wf2 \(workflow\) \(startup_failure\)/.test(r.failed ?? ''), r);

r = await run('G2', (p) => ({ runs: [...self, wrun(7, 2, 70, p < 2 ? { status: 'queued', conclusion: null } : {})], checks: [...selfChecks, ...(p < 2 ? [] : [cr(20, 'ci / ci', 70, 'completed', 'success')])] }));
expect('G2 run without jobs yet is waited for', r.failed === null && r.polls >= 4, r);

r = await run('H', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfChecks, cr(10, 'e2e (dev)', 50, 'completed', 'failure'), cr(11, 'slow-3', 50, 'in_progress', null)], statuses: [{ id: 3, context: 'RM E2E smoke (dev)', state: 'failure' }] }), { IGNORE: 'wf1 / e2e (dev)\nslow-\\d+\n  RM E2E smoke (dev)  \n' });
expect('H ignore: workflow-qualified literal, regex, literal with parens', r.failed === null && r.table.length === 4, r);

r = await run('H2', () => ({ runs: self, checks: selfChecks }), { IGNORE: 'foo (bar' });
expect('H2 invalid regex warns, does not crash', r.failed === null && r.warnings.length === 1, r);

r = await run('I', (p) => ({ runs: self, checks: [...selfChecks, ...(p >= 1 ? [cr(30, 'late', 555, p < 4 ? 'queued' : 'completed', p < 4 ? null : 'success', { app: { id: 8329 } })] : [])] }));
expect('I late check resets settle and is waited for', r.failed === null && r.polls >= 6 && r.table.length === 2, r);

for (const c of ['cancelled', 'timed_out', 'action_required', 'stale']) {
  r = await run('J', () => ({ runs: [...self, wrun(5, 1, 50)], checks: [...selfChecks, cr(10, 'x', 50, 'completed', c)] }));
  expect(`J ${c} -> red`, r.failed !== null, r);
}
r = await run('J2', () => ({ runs: [...self, wrun(5, 1, 50)], checks: [...selfChecks, cr(10, 'x', 50, 'completed', 'neutral'), cr(11, 'y', 50, 'completed', 'skipped')] }));
expect('J2 neutral/skipped pass', r.failed === null, r);

r = await run('K', () => ({ runs: self, checks: selfChecks, statuses: [{ id: 9, context: 'Vercel', state: 'success' }, { id: 8, context: 'Vercel', state: 'failure' }, { id: 7, context: 'other', state: 'error' }] }));
expect('K newest status per context; error -> red', /1 of 2 .*other \(error\)/.test(r.failed ?? ''), r);

r = await run('L', (p) => ({ runs: [...self, wrun(5, 1, 50)], checks: [...selfChecks, cr(10, 'x', 50, 'completed', 'failure'), cr(11, 'y', 50, 'in_progress', null)] }), { TIMEOUT_MINUTES: '5' });
expect('L timeout lists pending and failed', /still running: wf1 \/ y \(in_progress\); not passed: wf1 \/ x \(failure\)/.test(r.failed ?? ''), r);

r = await run('M1', (p) => (p < 3 ? { error: { status: 502, message: 'Bad Gateway' } } : { runs: [...self, wrun(5, 1, 50)], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure')] }));
expect('M1 failed polls never settle; real result after recovery', /did not pass/.test(r.failed ?? '') && r.polls >= 6, r);

r = await run('M2', () => ({ error: { status: 500, message: 'boom' } }));
expect('M2 polls that keep failing -> red, never green', /^threw: cannot read the checks of abc after 10 tries/.test(r.failed ?? ''), r);

r = await run('M3', () => ({ error: { status: 422, message: 'No commit found for SHA: abc' } }));
expect('M3 unknown sha -> red at once', /^threw: cannot read the checks of abc \(422/.test(r.failed ?? '') && r.polls === 1, r);

r = await run('M4', (p) => (p < 2 ? { error: { status: 403, message: 'API rate limit exceeded' } } : { runs: self, checks: selfChecks }));
expect('M4 rate limit is retried', r.failed === null && r.warnings.length === 2, r);

r = await run('N', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfChecks, cr(10, 'lint', 50, 'completed', 'failure'), cr(11, 'lint', 50, 'completed', 'success')] }));
expect('N two jobs sharing a name in one attempt both count', /wf1 \/ lint \(failure\)/.test(r.failed ?? ''), r);

r = await run('O', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' }), wrun(6, 1, 60)], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(13, 'build', 60, 'completed', 'skipped')] }));
expect('O a later run that skips the job does not hide its failure', /wf1 \/ build \/ build \(failure\)/.test(r.failed ?? ''), r);

r = await run('P', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfChecks, cr(10, 'x', 50, 'completed', 'success')] }));
expect('P a failed run without a failed check is red', /wf1 \(workflow\) \(failure\)/.test(r.failed ?? ''), r);

r = await run('Q', () => ({ runs: [wrun(1, 99, 999, { status: 'in_progress', conclusion: null })].slice(1), checks: selfChecks.slice(0, 1) }));
expect('Q own check is left out even before its run is listed', r.failed === null, r);

const build = (conclusion = 'success') => [wrun(5, 1, 50, { conclusion }), cr(10, 'build / build', 50, 'completed', conclusion)];
const copilotCheck = (status = 'completed', conclusion = 'failure') => cr(40, 'copilot-pull-request-reviewer', 80, status, conclusion);
const copilotRow = (t) => t.slice(1).find((row) => row[0].includes('Running Copilot Code Review / copilot-pull-request-reviewer'));

r = await run('R1', () => ({ runs: [...self, build()[0], copilot()], checks: [...selfChecks, build()[1], copilotCheck()] }));
expect('R1 failed Copilot code review is ignored', r.failed === null && /failure \(ignored\)/.test(copilotRow(r.table)?.[1] ?? ''), r);

r = await run('R2', () => ({ runs: [...self, build()[0], copilot({ status: 'in_progress', conclusion: null })], checks: [...selfChecks, build()[1], copilotCheck('in_progress', null)] }), { TIMEOUT_MINUTES: '10' });
expect('R2 running Copilot code review is not waited for', r.failed === null && r.elapsed < 120, r);

r = await run('R3', () => ({ runs: [...self, build()[0], copilot({ conclusion: 'startup_failure' })], checks: [...selfChecks, build()[1]] }));
expect('R3 Copilot run that failed without a check is ignored', r.failed === null && r.table.slice(1).some((row) => /Running Copilot Code Review \(workflow\)/.test(row[0]) && /\(ignored\)/.test(row[1])), r);

r = await run('R4', () => ({ runs: [...self, build()[0], copilot(), dyn(9, 300, 90, 'dynamic/github-code-scanning/codeql', 'CodeQL', { conclusion: 'failure' })], checks: [...selfChecks, build()[1], copilotCheck(), cr(41, 'Analyze (go)', 90, 'completed', 'failure')] }));
expect('R4 failed CodeQL dynamic run still fails the gate', /^1 of 2 checks did not pass: CodeQL \/ Analyze \(go\) \(failure\)/.test(r.failed ?? ''), r);

r = await run('R5', () => ({ runs: [...self, dyn(9, 301, 90, 'dynamic/dependabot/dependabot-updates', 'npm_and_yarn in /. - Update #1', { conclusion: 'failure' })], checks: [...selfChecks, cr(41, 'Dependabot', 90, 'completed', 'failure')] }));
expect('R5 failed Dependabot dynamic run still fails the gate', /npm_and_yarn in \/\. - Update #1 \/ Dependabot \(failure\)/.test(r.failed ?? ''), r);

r = await run('R6', () => ({ runs: [...self, wrun(8, 7, 80, { path: '.github/workflows/copilot.yml', name: 'Running Copilot Code Review', conclusion: 'failure' })], checks: [...selfChecks, copilotCheck()] }));
expect('R6 a repo workflow named like Copilot code review still counts', /Running Copilot Code Review \/ copilot-pull-request-reviewer \(failure\)/.test(r.failed ?? ''), r);

r = await run('R7', () => ({ runs: [...self, build()[0], copilot()], checks: [...selfChecks, build()[1], copilotCheck()] }), { COUNT_COPILOT_REVIEW: 'true' });
expect('R7 count_copilot_review makes Copilot code review count', /^1 of 2 checks did not pass: Running Copilot Code Review \/ copilot-pull-request-reviewer \(failure\)/.test(r.failed ?? ''), r);

r = await run('S', (p) => ({ runs: [...self, wrun(5, 1, 50, p < 3 ? { run_attempt: 2, status: 'queued', conclusion: null } : { run_attempt: 2 })], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(12, 'build / build', 50, p < 3 ? 'queued' : 'completed', p < 3 ? null : 'success')] }));
expect('S gate re-run while a check re-run is queued waits for it', r.failed === null && r.polls >= 5, r);

process.exit(fails ? 1 : 0);
