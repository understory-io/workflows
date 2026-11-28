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
// Job check runs link to their run's job; a check made through the API links to /runs/<id>.
const job = (runId, id) => ({ html_url: `https://github.com/o/r/actions/runs/${runId}/job/${id}` });
const copilotCheck = (status = 'completed', conclusion = 'failure') => cr(40, 'copilot-pull-request-reviewer', 80, status, conclusion, job(8, 40));
const copilotRow = (t) => t.slice(1).find((row) => row[0].includes('Running Copilot Code Review / copilot-pull-request-reviewer'));

r = await run('R1', () => ({ runs: [...self, build()[0], copilot()], checks: [...selfChecks, build()[1], copilotCheck()] }));
expect('R1 failed Copilot code review is ignored', r.failed === null && /failure \(ignored\)/.test(copilotRow(r.table)?.[1] ?? ''), r);

r = await run('R1b', () => ({
  runs: [...self, build()[0], dyn(8, 284823600, 80, 'dynamic/copilot-pull-request-reviewer/copilot-pull-request-reviewer', 'Copilot code review', { conclusion: 'failure' })],
  checks: [...selfChecks, build()[1], cr(43, 'Prepare', 80, 'completed', 'success', job(8, 43)), cr(44, 'Agent', 80, 'completed', 'failure', job(8, 44)), cr(45, 'Upload results', 80, 'completed', 'skipped', job(8, 45)), cr(46, 'Cleanup artifacts', 80, 'completed', 'cancelled', job(8, 46))],
}));
expect('R1b Copilot code review in its May 2026 shape (path, name, 4 jobs) is ignored', r.failed === null && r.table.slice(1).filter((row) => /\(ignored\)/.test(row[1])).length === 4, r);

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

r = await run('R8', () => ({ runs: [...self, copilot()], checks: [...selfChecks, copilotCheck(), cr(42, 'Go tests (api)', 80, 'completed', 'failure', { html_url: 'https://github.com/o/r/runs/42' })] }));
expect('R8 a reporter check run that landed in the Copilot check suite still counts, under its own name', /^1 of 1 checks did not pass: Go tests \(api\) \(failure\)/.test(r.failed ?? ''), r);

r = await run('R9', () => ({ runs: [...self, dyn(9, 302, 90, 'dynamic/copilot-swe-agent/copilot', 'Running Copilot coding agent', { conclusion: 'failure' })], checks: [...selfChecks, cr(41, 'copilot', 90, 'completed', 'failure')] }));
expect('R9 a failed Copilot coding agent run still counts', /Running Copilot coding agent \/ copilot \(failure\)/.test(r.failed ?? ''), r);
r = await run('R9b', () => ({ runs: [...self, dyn(9, 302, 90, 'dynamic/copilot-swe-agent/copilot', 'Running Copilot coding agent', { conclusion: 'startup_failure' })], checks: selfChecks }));
expect('R9b a Copilot coding agent run that failed without a check still counts', /Running Copilot coding agent \(workflow\) \(startup_failure\)/.test(r.failed ?? ''), r);

{
  // The scenarios set COUNT_COPILOT_REVIEW themselves; this proves the workflow passes the input on.
  const yml = wf.join('\n');
  const ok = /count_copilot_review:\n\s+description: [^\n]*\n(?:\s{10}[^\n]*\n)*\s+type: boolean\n\s+required: false\n\s+default: false\n/.test(yml) && yml.includes('COUNT_COPILOT_REVIEW: ${{ inputs.count_copilot_review }}');
  console.log(`${ok ? 'ok  ' : 'FAIL'} count_copilot_review is a boolean input, off by default, passed to the script`);
  if (!ok) fails++;
}

{
  // ownJob() in the script knows the gate's job by this name.
  const ok = /\njobs:\n  tests-passed:\n    name: tests-passed\n/.test(wf.join('\n'));
  console.log(`${ok ? 'ok  ' : 'FAIL'} the gate's job is named tests-passed, as ownJob() expects`);
  if (!ok) fails++;
}

// GitHub left this job's check run at in_progress with its result written
// (storefront check run 140264796184 on PR 1898, Nov 2026); its run completed.
const stuckCheck = (id, name, suite, conclusion, extra = {}) => cr(id, name, suite, 'in_progress', conclusion, { completed_at: '2026-11-27T01:54:22Z', ...extra });
const rowOf = (t, name) => t?.slice(1).find((row) => row[0].includes(`>${name}<`));

r = await run('T1', () => ({ runs: [...self, wrun(5, 1, 50)], checks: [...selfChecks, cr(10, 'ci', 50, 'completed', 'success'), stuckCheck(11, 'fungus codegen drift', 50, 'success')] }), { TIMEOUT_MINUTES: '10' });
expect('T1 a check run stuck at in_progress with conclusion success passes, without waiting', r.failed === null && r.elapsed < 120, r);
expect('T1 the summary and a notice say GitHub still reports in_progress', /success \(GitHub still reports in_progress\)$/.test(rowOf(r.table, 'wf1 / fungus codegen drift')?.[1] ?? '') && r.notices.some((n) => n.startsWith('wf1 / fungus codegen drift: success (GitHub still reports in_progress)')), r);

r = await run('T2', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfChecks, stuckCheck(10, 'build', 50, 'failure')] }), { TIMEOUT_MINUTES: '10' });
expect('T2 a check run stuck at in_progress with conclusion failure fails, without waiting', /^1 of 1 checks did not pass: wf1 \/ build \(failure\)\./.test(r.failed ?? '') && r.elapsed < 120, r);
expect('T2 its error says GitHub still reports in_progress', r.errors.some((e) => e.startsWith('wf1 / build: failure (GitHub still reports in_progress)')), r);

r = await run('T3', () => ({ runs: [...self, wrun(5, 1, 50, { status: 'in_progress', conclusion: null })], checks: [...selfChecks, cr(10, 'build', 50, 'in_progress', null, { completed_at: null })] }), { TIMEOUT_MINUTES: '5' });
expect('T3 in_progress with conclusion null stays pending until the timeout', /^timed out after 5 min; still running: wf1 \/ build \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('T4', () => ({ runs: [...self, wrun(5, 1, 50, { status: 'in_progress', conclusion: null })], checks: [...selfChecks, stuckCheck(10, 'build', 50, 'success', { completed_at: null })] }), { TIMEOUT_MINUTES: '5' });
expect('T4 a conclusion without completed_at is not enough: still pending', /^timed out after 5 min; still running: wf1 \/ build \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('T5', () => ({ runs: [...self, wrun(5, 1, 50, { status: 'in_progress', conclusion: 'success' })], checks: selfChecks }), { TIMEOUT_MINUTES: '5' });
expect('T5 a workflow run with no check runs counts by its status alone, conclusion or not', /^timed out after 5 min; still running: wf1 \(workflow\) \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('T6', () => ({ runs: [...self, wrun(5, 1, 50, { status: 'in_progress', conclusion: null })], checks: [...selfChecks, stuckCheck(10, 'build', 50, 'success')] }), { TIMEOUT_MINUTES: '5' });
expect('T6 a stuck check in a run still going waits: a job that needs it may not exist yet', /^timed out after 5 min; still running: wf1 \/ build \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('T7', (p) => ({ runs: [...self, wrun(5, 1, 50, p < 3 ? { status: 'in_progress', conclusion: null } : {})], checks: [...selfChecks, stuckCheck(10, 'build', 50, 'success'), ...(p < 3 ? [] : [cr(11, 'test', 50, 'completed', 'success')])] }));
expect('T7 it counts once its run completes, and the jobs after it are waited for', r.failed === null && r.polls >= 5 && r.table.length === 3, r);

r = await run('T8', () => ({ runs: self, checks: [...selfChecks, stuckCheck(10, 'Vercel', 555, 'success', { app: { id: 8329 } })] }), { TIMEOUT_MINUTES: '5' });
expect("T8 another app's check run counts by status alone", /^timed out after 5 min; still running: Vercel \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('T9', () => ({ runs: [...self, wrun(5, 1, 50, { run_attempt: 2, status: 'queued', conclusion: null })], checks: [...selfChecks, stuckCheck(10, 'build', 50, 'success'), cr(12, 'build', 50, 'queued', null)] }), { TIMEOUT_MINUTES: '5' });
expect("T9 a re-run's queued check run replaces a stuck one of the same name", /^timed out after 5 min; still running: wf1 \/ build \(queued\)/.test(r.failed ?? ''), r);

// A check run that test-report posts with GITHUB_TOKEN: completed at once,
// linked to /runs/<id>, filed by GitHub in the commit's first Actions check
// suite (bookings runs 45582310497 and 45989429597, Knock translations).
const posted = (id, name, suite, conclusion, extra = {}) => cr(id, name, suite, 'completed', conclusion, { html_url: `https://github.com/o/r/runs/${id}`, ...extra });
const jobCr = (id, name, suite, runId, status, conclusion, extra = {}) => cr(id, name, suite, status, conclusion, { ...job(runId, id), ...extra });
const GO = 'Go tests (bookings-core)';
// The gate's jobs with real links, so they read as jobs, not posted check runs.
const selfJobs = [cr(1, 'tests-passed / tests-passed', 999, 'in_progress', null, job(1, 1)), cr(0, 'tests-passed / tests-passed', 998, 'completed', 'cancelled', job(0, 0))];
// Knock translations (wf2, run 5, suite 50, first on the commit) and the build (wf1, run 6, suite 60).
const knock = (extra = {}) => [wrun(5, 2, 50, extra), jobCr(20, 'knock / preview', 50, 5, 'completed', 'success')];
const rerunBuild = () => [wrun(6, 1, 60, { run_attempt: 2 }), jobCr(21, 'build / build', 60, 6, 'completed', 'failure'), jobCr(22, 'build / build', 60, 6, 'completed', 'success')];
const goRows = (t) => t.slice(1).filter((row) => row[0].includes(`>${GO}<`));

r = await run('U1', () => ({ runs: [...self, knock()[0], rerunBuild()[0], wrun(7, 3, 70)], checks: [...selfJobs, knock()[1], ...rerunBuild().slice(1), posted(30, GO, 50, 'failure'), posted(31, GO, 70, 'success')] }));
expect('U1 a passing re-run report filed in another suite replaces the failed one', r.failed === null && goRows(r.table).length === 1 && /success/.test(goRows(r.table)[0][1]), r);

r = await run('U1b', () => ({ runs: [...self, knock()[0], rerunBuild()[0]], checks: [...selfJobs, knock()[1], ...rerunBuild().slice(1), posted(30, GO, 50, 'failure'), posted(31, GO, 50, 'success')] }));
expect('U1b a passing re-run report filed in the same first-attempt suite replaces the failed one', r.failed === null && goRows(r.table).length === 1, r);

r = await run('U1c', () => ({ runs: [...self, knock({ conclusion: 'failure' })[0], rerunBuild()[0], wrun(7, 3, 70)], checks: [...selfJobs, knock()[1], ...rerunBuild().slice(1), posted(30, GO, 50, 'failure'), posted(31, GO, 70, 'success')] }));
expect("U1c a replaced failed report doesn't hide its host run's own failure", /^1 of \d+ checks did not pass: wf2 \(workflow\) \(failure\)/.test(r.failed ?? ''), r);

r = await run('U1d', () => ({ runs: [...self, knock()[0], rerunBuild()[0], wrun(7, 3, 70)], checks: [...selfJobs, knock()[1], ...rerunBuild().slice(1), posted(30, GO, 70, 'success'), posted(31, GO, 50, 'failure')] }));
expect('U1d a newer failed report replaces an older pass', new RegExp(`^1 of \\d+ checks did not pass: ${GO.replace(/[()]/g, '\\$&')} \\(failure\\)`).test(r.failed ?? ''), r);

r = await run('U2', () => ({ runs: [...self, knock({ conclusion: 'failure' })[0], wrun(6, 1, 60, { conclusion: 'failure' })], checks: [...selfJobs, knock()[1], jobCr(21, 'build / build', 60, 6, 'completed', 'failure'), posted(30, GO, 50, 'failure')] }));
expect('U2 a failed report counts under its own name, and explains the run it was filed in', /^2 of 3 checks did not pass: Go tests \(bookings-core\) \(failure\), wf1 \/ build \/ build \(failure\)\./.test(r.failed ?? ''), r);

r = await run('U3', () => ({ runs: [...self, wrun(5, 2, 50), wrun(9, 4, 90)], checks: [...selfJobs, posted(30, GO, 90, 'failure'), posted(31, GO, 50, 'success')] }));
expect("U3 the newest report wins, not the one in the newest run's suite", r.failed === null, r);

r = await run('U4', () => ({ runs: self, checks: [...selfJobs, posted(30, GO, 999, 'failure')] }), { TIMEOUT_MINUTES: '10' });
expect("U4 a failed report filed in the gate's own suite counts (US-17700), without waiting for the gate", /^1 of 1 checks did not pass: Go tests \(bookings-core\) \(failure\)\./.test(r.failed ?? '') && r.elapsed < 120, r);

r = await run('U4b', () => ({ runs: self, checks: [...selfJobs, posted(30, GO, 999, 'success')] }), { TIMEOUT_MINUTES: '10' });
expect("U4b a passing report in the gate's own suite passes after the settle, not a timeout", r.failed === null && r.elapsed < 120 && goRows(r.table).length === 1, r);

r = await run('U4c', () => ({ runs: self, checks: [...selfJobs, posted(30, GO, 998, 'failure')] }));
expect("U4c a failed report filed in an earlier, cancelled gate run's suite counts", /^1 of 1 checks did not pass: Go tests/.test(r.failed ?? ''), r);

for (const [label, url] of [['no link', null], ['an old-style link', 'https://github.com/o/r/runs/1?check_suite_focus=true'], ['a link like a posted one', 'https://github.com/o/r/runs/1']]) {
  r = await run('U4d', () => ({ runs: self, checks: [cr(1, 'tests-passed / tests-passed', 999, 'in_progress', null, { html_url: url }), selfJobs[1]] }), { TIMEOUT_MINUTES: '10' });
  expect(`U4d the gate's own running job with ${label} is still left out`, r.failed === null && r.elapsed < 120, r);
}

r = await run('U4e', () => ({ runs: self, checks: [...selfJobs, cr(2, 'lint', 999, 'completed', 'failure', { html_url: 'https://github.com/o/r/actions/runs/1/job/2' })] }));
expect("U4e another job of the gate's workflow is still left out", r.failed === null, r);

r = await run('U5', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' }), wrun(6, 3, 60)], checks: [...selfJobs, jobCr(21, 'test', 50, 5, 'completed', 'failure'), jobCr(22, 'test', 60, 6, 'completed', 'success'), posted(30, 'Go tests', 50, 'failure'), posted(31, 'Go tests', 50, 'success')] }));
expect("U5 two reporters titled alike collapse to the newest; the failed test job still fails the gate", /^1 of 3 checks did not pass: wf1 \/ test \(failure\)\./.test(r.failed ?? '') && r.table.slice(1).filter((row) => row[0].includes('>Go tests<')).length === 1, r);

r = await run('U6', (p) => ({ runs: [...self, knock()[0], wrun(6, 1, 60, p < 3 ? { status: 'in_progress', conclusion: null } : { conclusion: 'failure' })], checks: [...selfJobs, knock()[1], jobCr(21, 'build / build', 60, 6, p < 3 ? 'in_progress' : 'completed', p < 3 ? null : 'failure'), ...(p >= 1 ? [posted(30, GO, 50, 'success')] : [])] }));
expect('U6 a report filed while its job still runs: the job is waited for and counts', /^1 of 3 checks did not pass: wf1 \/ build \/ build \(failure\)\./.test(r.failed ?? '') && r.polls >= 4, r);

r = await run('U6b', (p) => ({ runs: [...self, wrun(7, 3, 70, p < 3 ? { status: 'queued', conclusion: null } : {})], checks: [...selfJobs, posted(30, GO, 70, 'success'), ...(p < 3 ? [] : [jobCr(23, 'deploy', 70, 7, 'completed', 'success')])] }));
expect('U6b a run whose suite holds only a report is still starting, and is waited for', r.failed === null && r.polls >= 5 && r.table.length === 3, r);

r = await run('U7', () => ({ runs: [...self, wrun(5, 2, 50)], checks: [...selfJobs, posted(30, GO, 50, 'success', { status: 'in_progress', completed_at: '2026-11-27T01:54:22Z' })] }), { TIMEOUT_MINUTES: '5' });
expect("U7 a report left at in_progress counts by status alone, not by its suite's run", /^timed out after 5 min; still running: Go tests \(bookings-core\) \(in_progress\)/.test(r.failed ?? ''), r);

r = await run('U7b', () => ({ runs: [...self, wrun(5, 1, 50)], checks: [...selfJobs, stuckCheck(21, 'build', 50, 'success', job(5, 21))] }), { TIMEOUT_MINUTES: '10' });
expect('U7b a job linked to its run, stuck at in_progress in a completed run, still passes at once', r.failed === null && r.elapsed < 120, r);

r = await run('U8', () => ({ runs: [...self, knock()[0]], checks: [...selfJobs, knock()[1], posted(30, GO, 50, 'failure')] }), { IGNORE: 'wf2 / Go tests \\(bookings-core\\)' });
expect("U8 a report isn't ignored by the name of the workflow it was filed in", /did not pass: Go tests/.test(r.failed ?? ''), r);
r = await run('U8b', () => ({ runs: [...self, knock()[0]], checks: [...selfJobs, knock()[1], posted(30, GO, 50, 'failure')] }), { IGNORE: 'Go tests \\(.*\\)' });
expect('U8b a report is ignored by its own name', r.failed === null && /\(ignored\)/.test(goRows(r.table)[0]?.[1] ?? ''), r);

r = await run('U9', () => ({ runs: [...self, wrun(5, 2, 50, { conclusion: 'startup_failure' }), wrun(7, 3, 70)], checks: [...selfJobs, jobCr(23, 'deploy', 70, 7, 'completed', 'success'), posted(30, GO, 50, 'failure'), posted(31, GO, 70, 'success')] }));
expect('U9 a run that never started stays red, though a replaced failed report sits in its suite', /^1 of \d+ checks did not pass: wf2 \(workflow\) \(startup_failure\)/.test(r.failed ?? ''), r);

r = await run('U10', () => ({ runs: [...self, wrun(5, 1, 50, { conclusion: 'failure' })], checks: [...selfJobs, jobCr(21, GO, 50, 5, 'completed', 'failure'), posted(30, GO, 50, 'success')] }));
expect("U10 a newer report never replaces a job's failure of the same name", /did not pass: wf1 \/ Go tests \(bookings-core\) \(failure\)/.test(r.failed ?? ''), r);

r = await run('S', (p) =>({ runs: [...self, wrun(5, 1, 50, p < 3 ? { run_attempt: 2, status: 'queued', conclusion: null } : { run_attempt: 2 })], checks: [...selfChecks, cr(10, 'build / build', 50, 'completed', 'failure'), cr(12, 'build / build', 50, p < 3 ? 'queued' : 'completed', p < 3 ? null : 'success')] }));
expect('S gate re-run while a check re-run is queued waits for it', r.failed === null && r.polls >= 5, r);

process.exit(fails ? 1 : 0);
