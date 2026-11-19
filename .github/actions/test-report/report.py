"""Reports test results: job summary, check run and one PR comment per title.

Reads JUnit XML, or first converts a `go test -v` log with go-junit-report.
Raw test output goes only into the job summary, which the runner masks like
the log. The check run, its annotations and the PR comment go through the API,
which masks nothing, so they name tests and lines but carry no output.

Only ever reports: a failed request ends in a note or a warning, never in a
failed step. Settings come from the environment that action.yml sets.
"""

import glob
import html
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass

SLOWEST = 10
OUTPUT_LINES = 200
LISTED = 30
# The runner drops a step summary over 1 MiB.
SUMMARY_BYTES = 800_000
# The command-based fallback shows at most 10 errors per step.
COMMAND_ANNOTATIONS = 10
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
TASK_PREFIX = re.compile(r"^\[([^\]\s]+)\] ?(.*)$")

env = os.environ.get
TITLE = env("TITLE", "Tests")
# What the first table column is: Go reports a package, JUnit from other runners a test file.
SUITE = "Package" if env("GO_TEST_LOG") else "File"
MARKER = f"<!-- test-report: {TITLE} -->"
SERVER = env("GITHUB_SERVER_URL", "https://github.com")
REPO = env("GITHUB_REPOSITORY", "")
SHA = env("HEAD_SHA") or env("GITHUB_SHA", "")
RUN_URL = f"{SERVER}/{REPO}/actions/runs/{env('GITHUB_RUN_ID', '')}"
JOB_URL = f"{RUN_URL}/job/{env('JOB_ID')}" if env("JOB_ID") else RUN_URL


@dataclass
class Case:
    package: str
    name: str
    secs: float
    status: str
    file: str = ""
    line: str = ""
    output: str = ""


def seconds(value):
    try:
        return float(value or 0)
    except ValueError:
        return 0.0


def duration(secs):
    if secs < 1:
        return f"{secs * 1000:.0f}ms"
    if secs < 60:
        return f"{secs:.1f}s"
    return f"{int(secs // 60)}m {secs % 60:.0f}s"


def oneline(text):
    return str(text).replace("%", "%25").replace("\r", " ").replace("\n", " ")


def cell(text):
    return "`" + text.replace("`", "'").replace("|", "\\|").replace("\n", " ") + "`"


def warn(text):
    print(f"::warning::{oneline(text)}")


def split_tasks(lines):
    """Parallel mise tasks prefix each line with `[task] ` and interleave, and
    go-junit-report reads one `go test` run at a time, so each task's lines
    become a log of their own."""
    text = [line for line in lines if line.strip()]
    if not text or 2 * sum(1 for line in text if TASK_PREFIX.match(line)) < len(text):
        return [lines]
    tasks = {}
    for line in lines:
        match = TASK_PREFIX.match(line)
        task, body = match.groups() if match else ("", line)
        tasks.setdefault(task, []).append(body)
    return list(tasks.values())


def convert_go_log(log, work_dir, converter):
    with open(log, encoding="utf-8", errors="replace") as f:
        lines = [ANSI.sub("", line.rstrip("\n")) for line in f]
    os.makedirs(os.path.join(work_dir, "junit"), exist_ok=True)
    paths = []
    for i, task_lines in enumerate(split_tasks(lines)):
        src = os.path.join(work_dir, f"go-test-{i}.log")
        dst = os.path.join(work_dir, "junit", f"go-test-{i}.xml")
        with open(src, "w", encoding="utf-8") as f:
            f.write("\n".join(task_lines) + "\n")
        subprocess.run([converter, "-in", src, "-out", dst], check=True)
        paths.append(dst)
    return paths


def module_path(module_dir):
    with open(os.path.join(module_dir, "go.mod"), encoding="utf-8") as mod:
        return next(line.split()[1] for line in mod if line.startswith("module "))


def go_location(case, module, module_dir):
    """The `_test.go` line a Go failure reports, so its annotation lands there
    rather than on a path the package name suggests."""
    if not (case.package + "/").startswith(module + "/"):
        return
    # A panic's innermost test frame; otherwise the last reported line, as logs
    # come before the failure and t.Fatal ends the test.
    frames = re.findall(r"([\w.-]+_test\.go):(\d+) \+0x", case.output)
    lines = re.findall(r"([\w.-]+_test\.go):(\d+):", case.output)
    if not (frames or lines):
        return
    name, line = frames[0] if frames else lines[-1]
    path = os.path.normpath(os.path.join(module_dir, case.package[len(module):].lstrip("/"), name))
    if os.path.isfile(path):
        workspace = env("GITHUB_WORKSPACE") or os.getcwd()
        case.file = os.path.relpath(path, workspace) if os.path.isabs(path) else path
        case.line = line


def junit_location(case, junit_file):
    """The line of a failure in JUnit from a runner that names the test file as
    the class (vitest does) and prints it with `:line:column` in the failure.
    The class is relative to the project that ran the tests, which in a
    monorepo is a directory above the JUnit file, so the file is looked for
    there first and then at the repository root."""
    workspace = os.path.realpath(env("GITHUB_WORKSPACE") or os.getcwd())
    root = os.path.dirname(os.path.realpath(junit_file))
    roots = []
    while root.startswith(workspace + os.sep):
        roots.append(root)
        root = os.path.dirname(root)
    for root in roots + [workspace]:
        path = os.path.realpath(os.path.join(root, case.package))
        if path.startswith(workspace + os.sep) and os.path.isfile(path):
            break
    else:
        return
    line = re.search(re.escape(case.package) + r":(\d+):\d+", case.output)
    if line:
        case.file = os.path.relpath(path, workspace)
        case.line = line.group(1)


def read_results(paths, module_dir):
    """Returns the cases, the number of suites that passed without listing a
    test, and why the results can't be used, if they can't."""
    module = ""
    if module_dir:
        try:
            module = module_path(module_dir)
        except (OSError, StopIteration) as err:
            warn(f"no Go module in {module_dir}, so failures get no line: {err}")
    cases, quiet = [], 0
    for path in paths:
        try:
            tree = ET.parse(path)
        except (ET.ParseError, OSError) as err:
            warn(f"skipping {path}, which is not readable JUnit: {err}")
            continue
        for suite in tree.iter("testsuite"):
            # go-junit-report leaves a panic's stack, and all output of a run
            # without -v, in the package's output rather than the test's.
            suite_output = "\n".join((suite.findtext("system-out") or "").splitlines()[-OUTPUT_LINES:])
            found = suite.findall("testcase")
            # Shared output names a line only when one test failed.
            sole_failure = sum(1 for el in found if el.find("failure") is not None or el.find("error") is not None) == 1
            if not found and suite.find("failure") is None and suite.find("error") is None:
                quiet += 1
            for el in found:
                problem = el.find("failure")
                if problem is None:
                    problem = el.find("error")
                status = "failed" if problem is not None else "skipped" if el.find("skipped") is not None else "passed"
                case = Case(el.get("classname", ""), el.get("name", ""), seconds(el.get("time")), status)
                if problem is not None:
                    case.output = (problem.text or "").strip("\n")
                    own = bool(case.output) or sole_failure
                    case.output = case.output or suite_output or problem.get("message", "")
                    if module and own:
                        go_location(case, module, module_dir)
                    elif not module_dir:
                        junit_location(case, path)
                cases.append(case)
    if any(not c.package for c in cases):
        return [], 0, (
            "the test output isn't in a format the reporter reads (gotestsum's `--format github-actions`, "
            "for example). Go tests are read from plain `go test -v` output"
        )
    return cases, quiet, ""


def counted(cases):
    """A Go parent test fails along with its subtest, and its time includes its
    subtests', so count leaf tests, and a parent only for a failure of its own."""
    parents, failing_parents = set(), set()
    for c in cases:
        for i in range(1, c.name.count("/") + 1):
            ancestor = (c.package, c.name.rsplit("/", i)[0])
            parents.add(ancestor)
            if c.status == "failed":
                failing_parents.add(ancestor)
    return [
        c for c in cases
        if (c.package, c.name) not in parents or (c.status == "failed" and (c.package, c.name) not in failing_parents)
    ]


def outcome_headline(outcome):
    return {
        "success": ("✅", "passed"),
        "failure": ("❌", "failed"),
    }.get(outcome, ("⚠️", "didn't run" if outcome == "skipped" else "finished"))


def location(case, link):
    if not case.file:
        return ""
    label = f"{os.path.basename(case.file)}:{case.line}"
    if not link:
        return label
    return f"[{label}]({SERVER}/{REPO}/blob/{SHA}/{case.file}#L{case.line})"


def failed_table(failed, link):
    rows = ["| Failed test | " + SUITE + " | Line |", "|---|---|---|"]
    for c in failed[:LISTED]:
        rows.append(f"| {cell(c.name or '(package)')} | {cell(c.package)} | {location(c, link)} |")
    if len(failed) > LISTED:
        rows.append(f"\n{len(failed) - LISTED} more in the job summary.")
    return "\n".join(rows)


def counts_line(tests, failed, skipped, no_passing):
    if no_passing:
        text = f"{failed} test{'s' if failed != 1 else ''} failed. Passing tests aren't listed: Go lists them only with `go test -v`."
    elif failed:
        text = f"{failed} of {tests} tests failed."
    else:
        text = f"{tests} tests passed."
    if skipped:
        text += f" {skipped} skipped."
    return text


def published_body(text, outcome):
    """The check run summary and the PR comment: names, never output."""
    short = SHA[:7]
    return (
        f"{MARKER}\n### {outcome_headline(outcome)[0]} {TITLE}\n\n"
        f"Commit [`{short}`]({SERVER}/{REPO}/commit/{SHA}) · [job]({JOB_URL})\n\n{text}\n"
    )


class Api:
    def __init__(self, token):
        self.token = token
        self.base = f"{env('GITHUB_API_URL', 'https://api.github.com')}/repos/{REPO}"

    def __call__(self, method, path, body=None):
        request = urllib.request.Request(
            f"{self.base}/{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
            return json.loads(data) if data else None


def denied(err):
    """403 is a token without the permission (Dependabot, or a caller that
    narrowed `permissions:`): expected, so a note rather than a warning."""
    if isinstance(err, urllib.error.HTTPError) and err.code == 403:
        return True
    warn(f"test report request failed: {err}")
    return False


def publish_check(api, failed, text, body):
    body = body.removeprefix(MARKER + "\n")[:60000]
    annotations = [
        {
            "path": c.file,
            "start_line": int(c.line),
            "end_line": int(c.line),
            "annotation_level": "failure",
            "title": f"{c.name} failed",
            "message": f"{c.name} failed in {c.package}. Its output is in the job summary: {JOB_URL}",
        }
        for c in failed
        if c.file
    ]
    first = annotations[:50]
    run = api("POST", "check-runs", {
        "name": TITLE,
        "head_sha": SHA,
        "status": "completed",
        "conclusion": "failure" if failed else "success",
        "output": {"title": text, "summary": body, "annotations": first},
    })
    for i in range(50, len(annotations), 50):
        api("PATCH", f"check-runs/{run['id']}", {
            "output": {"title": text, "summary": body, "annotations": annotations[i:i + 50]},
        })


def command_annotations(failed):
    """Without the check, annotate through the log, which the runner masks."""
    for c in [c for c in failed if c.file][:COMMAND_ANNOTATIONS]:
        props = ",".join(f"{k}={oneline(v).replace(':', '%3A').replace(',', '%2C')}" for k, v in
                         (("file", c.file), ("line", c.line), ("title", f"{c.name} failed")))
        print(f"::error {props}::{oneline(f'{c.name} failed in {c.package}. Its output is in the job summary.')}")


def existing_comment(api, pr):
    for page in range(1, 31):
        comments = api("GET", f"issues/{pr}/comments?per_page=100&page={page}")
        for comment in comments:
            if (comment.get("body") or "").startswith(MARKER):
                return comment["id"]
        if len(comments) < 100:
            return None
    return None


def publish_comment(api, pr, body, create):
    """Updates this title's comment. Creates it only for a real report, so a
    run without one never adds a comment, but never leaves an old green one
    standing either."""
    comment = existing_comment(api, pr)
    if comment:
        api("PATCH", f"issues/comments/{comment}", {"body": body})
    elif create:
        api("POST", f"issues/{pr}/comments", {"body": body})


def head_moved(api, pr):
    """Whether the PR has a newer commit than this run's. Runs of one PR can
    finish out of order, and the older one must not overwrite the comment."""
    return api("GET", f"pulls/{pr}")["head"]["sha"] != SHA


def fence(text):
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def summary(outcome, tests, cases, failed, skipped, no_passing, problem, notes):
    icon, verb = outcome_headline(outcome)
    out = [f"### {icon} {TITLE}\n", f"The test step {verb}."]
    if problem:
        out.append(f" There is no test report: {problem}.")
    out.append("\n\n")
    if tests:
        out.append(counts_line(tests, len(failed), skipped, no_passing) + "\n\n")
    out.extend(f"> {note}\n\n" for note in notes)
    size = sum(len(part.encode()) for part in out)
    shown = 0
    for c in failed:
        lines = c.output.splitlines()[-OUTPUT_LINES:]
        body = "\n".join(lines)
        where = f" ({html.escape(location(c, False))})" if c.file else ""
        block = (
            f"<details><summary><code>{html.escape(c.name or '(package)')}</code> in "
            f"<code>{html.escape(c.package)}</code>{where}</summary>\n\n"
            f"{fence(body)}text\n{body}\n{fence(body)}\n\n</details>\n\n"
        )
        if size + len(block.encode()) > SUMMARY_BYTES:
            break
        out.append(block)
        size += len(block.encode())
        shown += 1
    if shown < len(failed):
        out.append(f"{len(failed) - shown} more failed tests: see the log.\n\n")
    ranked = sorted((c for c in cases if c.status != "skipped" and c.secs > 0), key=lambda c: c.secs, reverse=True)[:SLOWEST]
    if ranked:
        out.append("<details><summary>Slowest tests</summary>\n\n| Time | Test | " + SUITE + " |\n|---:|---|---|\n")
        out.extend(f"| {duration(c.secs)} | {cell(c.name)} | {cell(c.package)} |\n" for c in ranked)
        out.append("\n</details>\n\n")
    return "".join(out)


def main():
    work_dir = env("WORK_DIR")
    outcome = env("TEST_OUTCOME", "")
    paths, problem = [], ""
    if env("GO_TEST_LOG"):
        log = env("GO_TEST_LOG")
        if not os.path.isfile(log) or not os.path.getsize(log):
            problem = "an earlier step failed" if outcome == "skipped" else "the tests wrote no output"
        elif not env("GO_JUNIT_REPORT"):
            problem = "go-junit-report could not be installed"
        else:
            try:
                paths = convert_go_log(log, work_dir, env("GO_JUNIT_REPORT"))
            except (OSError, subprocess.CalledProcessError) as err:
                warn(f"could not convert the test output to JUnit: {err}")
                problem = "the test output could not be converted"
    else:
        patterns = env("JUNIT_PATH", "")
        paths = sorted({f for p in patterns.splitlines() if p.strip() for f in glob.glob(p.strip(), recursive=True)})
        if not paths:
            problem = "no JUnit files were found"

    cases, quiet, unreadable = read_results(paths, env("GO_MODULE_DIR", "")) if paths else ([], 0, "")
    problem = problem or unreadable
    leaves = counted(cases)
    failed = [c for c in leaves if c.status == "failed"]
    skipped = sum(1 for c in leaves if c.status == "skipped")
    passed = sum(1 for c in leaves if c.status == "passed")
    tests = len(leaves)
    no_passing = bool(failed) and not passed and quiet > 0
    notes = []
    if not problem and not tests and outcome != "failure":
        problem = "the output lists no tests. Go lists each test only with `go test -v`"
    elif not problem and outcome == "failure" and not failed:
        problem = "no test in its output failed, so a build error, a panic outside a test or a command after the tests failed it; the log has the cause"
    elif not problem and outcome == "success" and failed:
        problem = "the test step passed, but its output reports failed tests"
    elif not problem and outcome not in ("", "success", "failure"):
        problem = f"the test step's outcome was `{outcome}`"
    if not outcome and tests:
        outcome = "failure" if failed else "success"
    if problem and tests:
        notes.append("These results are only here: they don't match the test step's outcome, so no check or PR comment has them.")

    with open(env("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as out:
        out.write(f"files={len(paths)}\ntests={tests}\nfailed={len(failed)}\nskipped={skipped}\n")

    api = Api(env("TOKEN", ""))
    pr = env("PR", "")
    text = counts_line(tests, len(failed), skipped, no_passing)
    if problem:
        body = published_body(f"The test step {outcome_headline(outcome)[1]}. There is no test report: {problem}.", outcome)
    else:
        details = f"\n\n{failed_table(failed, True)}\n\nThe output of each failure is in the job summary." if failed else ""
        body = published_body(text + details, outcome)
        try:
            publish_check(api, failed, text, body)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            if denied(err):
                notes.append("This job's token can't write checks (Dependabot, or the caller narrowed `permissions:`), so there is no check run.")
            command_annotations(failed)
    if pr:
        try:
            if head_moved(api, pr):
                notes.append("The PR has a newer commit, so its run owns the PR comment and this one left it alone.")
            else:
                publish_comment(api, pr, body, create=not problem)
        except (urllib.error.URLError, OSError, ValueError, KeyError) as err:
            if denied(err):
                notes.append("This job's token can't write PR comments (Dependabot, or the caller narrowed `permissions:`), so there is no PR comment.")

    with open(env("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as out:
        out.write(summary(outcome, tests, leaves, failed, skipped, no_passing, problem, notes))

if __name__ == "__main__":
    sys.exit(main())
