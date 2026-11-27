// Runs the "Update lambda image uri" step of lambda-ecr.yml with the real AWS
// CLI against a fake Lambda API: node test/lambda-ecr.mjs .github/workflows/lambda-ecr.yml
// The script is cut out of the YAML unchanged and run as GitHub runs it
// (bash -e). AWS_ENDPOINT_URL_LAMBDA points the CLI at the fake, so a waiter
// the runner's CLI lacks would show up as a missing GetFunction call rather
// than hide behind `|| true`. A `timeout` shim records each limit the script
// asks for and enforces a short one, so a hanging wait costs seconds here.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const wf = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const stepAt = wf.findIndex((l) => l.trim() === '- name: Update lambda image uri');
const stepIndent = wf[stepAt].indexOf('-');
const step = [];
for (const l of wf.slice(stepAt + 1)) { if (l.trim() && l.search(/\S/) <= stepIndent) break; step.push(l); }
const runAt = step.findIndex((l) => l.trim() === 'run: |');
const bodyIndent = step[runAt + 1].search(/\S/);
const body = [];
for (const l of step.slice(runAt + 1)) { if (l.trim() && l.search(/\S/) < bodyIndent) break; body.push(l.slice(bodyIndent)); }
const stepText = step.join('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-ecr-'));
const script = path.join(tmp, 'step.sh');
fs.writeFileSync(script, body.join('\n'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
const timeoutLog = path.join(tmp, 'timeout.log');
const WAIT_LIMIT = 4;
fs.writeFileSync(path.join(bin, 'timeout'), `#!/usr/bin/env bash
echo "$1" >> "$TIMEOUT_LOG"
shift
exec perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$WAIT_LIMIT" "$@"
`, { mode: 0o755 });

const FN = 'invoicing-engine';
const IMAGE = '123456789012.dkr.ecr.eu-west-1.amazonaws.com/invoicing-engine:dev-latest';
const ARN = `arn:aws:lambda:eu-west-1:123456789012:function:${FN}`;
const config = (status) => ({ FunctionName: FN, FunctionArn: ARN, PackageType: 'Image', State: 'Active', LastUpdateStatus: status });
const ERRORS = {
  conflict: [409, 'ResourceConflictException', `The operation cannot be performed at this time. An update is in progress for resource: ${ARN}`],
  pending: [409, 'ResourceConflictException', 'The operation cannot be performed at this time. The function is currently in the following state: Pending'],
  denied: [403, 'AccessDeniedException', `User is not authorized to perform: lambda:UpdateFunctionCode on resource: ${ARN}`],
  invalid: [400, 'InvalidParameterValueException', 'Source image does not exist. Provide a valid source image.'],
  notfound: [404, 'ResourceNotFoundException', `Function not found: ${ARN}`],
  server: [500, 'ServiceException', 'Internal failure.'],
};

// scenario.update: one entry per UpdateFunctionCode request ('ok' or an ERRORS
// key), the last repeating. scenario.status: LastUpdateStatus per GetFunction
// request, the last repeating.
async function run(scenario) {
  const calls = [];
  let updates = 0, gets = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (code, obj, type) => {
        res.writeHead(code, { 'content-type': 'application/json', ...(type ? { 'x-amzn-errortype': type } : {}) });
        res.end(JSON.stringify(obj));
      };
      // GetFunction only, what the v2 waiter calls: the job's existence check
      // already relies on it, so the wait needs no permission the job lacked.
      if (req.method === 'GET' && req.url.split('?')[0] === `/2015-03-31/functions/${FN}`) {
        const s = scenario.status ?? ['Successful'];
        const status = s[Math.min(gets++, s.length - 1)];
        calls.push(`get:${status}`);
        return send(200, { Configuration: config(status), Code: { RepositoryType: 'ECR', ImageUri: IMAGE } });
      }
      if (req.method === 'PUT' && req.url === `/2015-03-31/functions/${FN}/code`) {
        const u = scenario.update;
        const outcome = u[Math.min(updates++, u.length - 1)];
        calls.push(`update:${outcome}:${JSON.parse(raw).ImageUri}`);
        if (outcome === 'ok') return send(200, config('InProgress'));
        const [code, type, message] = ERRORS[outcome];
        return send(code, { Type: 'User', message }, type);
      }
      calls.push(`unexpected:${req.method} ${req.url}`);
      send(400, { message: 'unexpected' }, 'InvalidRequestContentException');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(timeoutLog, '');
  const started = Date.now();
  const child = spawn('bash', ['-e', script], {
    detached: true,
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: tmp, TIMEOUT_LOG: timeoutLog, WAIT_LIMIT: String(WAIT_LIMIT),
      AWS_ENDPOINT_URL_LAMBDA: `http://127.0.0.1:${server.address().port}`,
      AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'eu-west-1', AWS_DEFAULT_REGION: 'eu-west-1',
      AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
      LAMBDA_EXISTS: 'true', FUNCTION_NAME: FN, IMAGE_URI: IMAGE, EVENT_NAME: scenario.event ?? 'pull_request',
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  // A script whose wait isn't bounded would otherwise hang this test too.
  const deadline = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 60_000);
  const rc = await new Promise((r) => child.on('close', (code, signal) => r(signal ? `killed after 60s` : code)));
  clearTimeout(deadline);
  server.close();
  const limits = fs.readFileSync(timeoutLog, 'utf8').split('\n').filter(Boolean);
  const r = { rc, out, calls, limits, seconds: (Date.now() - started) / 1000 };
  r.updates = calls.filter((c) => c.startsWith('update:'));
  r.images = new Set(r.updates.map((c) => c.split(':').slice(2).join(':')));
  return r;
}

let fails = 0;
const expect = (label, cond, r) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}  [rc=${r.rc} t=${r.seconds.toFixed(1)}s calls=${r.calls.join(',').replaceAll(`:${IMAGE}`, '')} timeouts=${r.limits.join(',')}]`);
  if (!cond) { fails++; console.log(r.out.replace(/^/gm, '      | ')); }
};
const onlyImage = (r) => r.images.size === 1 && r.images.has(IMAGE);
const waited90 = (r, n) => r.limits.length === n && r.limits.every((l) => l === '90');

expect('the step reads its inputs from env, wired as before',
  stepText.includes('FUNCTION_NAME: ${{ inputs.aws_function_name }}') &&
  stepText.includes('IMAGE_URI: ${{ steps.login-ecr.outputs.registry }}/${{ inputs.ecr_repository_name }}:${{ inputs.image_tag_prefix }}latest') &&
  stepText.includes("if: inputs.aws_function_name != '' && env.LAMBDA_EXISTS == 'true'") &&
  stepText.includes('EVENT_NAME: ${{ github.event_name }}') &&
  !body.join('\n').includes('${{'), { rc: '-', calls: [], limits: [], seconds: 0, out: stepText });

let r;
r = await run({ update: ['ok'] });
expect('no conflict -> one bounded wait, one update, exit 0, the CLI output printed',
  r.rc === 0 && r.calls.join() === `get:Successful,update:ok:${IMAGE}` && waited90(r, 1) && r.out.includes(`"FunctionName": "${FN}"`) && !r.out.includes('retrying'), r);

r = await run({ update: ['conflict', 'ok'], status: ['Successful', 'InProgress', 'Successful'] });
expect('conflict -> waits until the other update is done, retries, succeeds',
  r.rc === 0 && r.calls.join() === `get:Successful,update:conflict:${IMAGE},get:InProgress,get:Successful,update:ok:${IMAGE}` &&
  waited90(r, 2) && r.out.includes('An error occurred (ResourceConflictException)') && r.out.includes('retrying (attempt 1 of 3)') && onlyImage(r), r);

r = await run({ update: ['conflict', 'pending', 'ok'] });
expect('two conflicts (either message) -> third attempt succeeds', r.rc === 0 && r.updates.length === 3 && waited90(r, 3) && onlyImage(r), r);

r = await run({ update: ['conflict'] });
expect('conflict every time -> fails after exactly 3 attempts with the CLI exit code',
  r.rc === 254 && r.updates.length === 3 && waited90(r, 3) && r.out.includes('still in progress after 3 attempts') && !r.out.includes('attempt 3 of 3'), r);

for (const kind of ['denied', 'invalid', 'notfound']) {
  r = await run({ update: [kind, 'ok'] });
  expect(`${ERRORS[kind][1]} -> fails at once, no retry`,
    r.rc === 254 && r.calls.join() === `get:Successful,update:${kind}:${IMAGE}` && waited90(r, 1) && r.out.includes(`(${ERRORS[kind][1]})`) && !r.out.includes('retrying'), r);
}

r = await run({ update: ['server'] });
expect('ServiceException -> fails after the CLI\'s own retries, no retry by the step',
  r.rc === 254 && r.updates.length >= 2 && r.updates.length <= 5 && waited90(r, 1) && !r.out.includes('retrying'), r);

// The one way the step sends the same update twice: the first request went
// through but its answer was lost, and the CLI's own retry then hit our own
// update in progress. The step waits for it and sends the same image again.
r = await run({ update: ['server', 'conflict', 'ok'], status: ['Successful', 'InProgress', 'Successful'] });
expect('lost answer, CLI retry hits our own update -> waits, sends the same image again, exit 0',
  r.rc === 0 && r.updates.length === 3 && waited90(r, 2) && onlyImage(r), r);

r = await run({ update: ['conflict', 'denied', 'ok'] });
expect('conflict, then another error -> fails at once on the other error', r.rc === 254 && r.updates.length === 2 && waited90(r, 2), r);

r = await run({ update: ['ok'], status: ['Failed'] });
expect('previous update Failed -> the wait gives up at once and the update still runs',
  r.rc === 0 && r.calls.join() === `get:Failed,update:ok:${IMAGE}` && waited90(r, 1), r);

r = await run({ update: ['conflict'], status: ['InProgress'] });
expect(`update never finishes -> each wait is cut at its limit, 3 attempts, then fails`,
  r.rc === 254 && r.updates.length === 3 && waited90(r, 3) && r.seconds < 3 * WAIT_LIMIT + 15, r);

// Deploys from main (prod) and tags keep the old one-shot update: no wait, no
// retry, so an older run can't put its image live after a newer one.
for (const event of ['push', 'workflow_dispatch']) {
  r = await run({ event, update: ['conflict', 'ok'], status: ['InProgress'] });
  expect(`${event}: a conflict fails at once, without waiting or retrying`,
    r.rc === 254 && r.calls.join() === `update:conflict:${IMAGE}` && r.limits.length === 0 && !r.out.includes('retrying'), r);
  r = await run({ event, update: ['ok'] });
  expect(`${event}: no conflict -> one update, no wait, exit 0`,
    r.rc === 0 && r.calls.join() === `update:ok:${IMAGE}` && r.limits.length === 0, r);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
