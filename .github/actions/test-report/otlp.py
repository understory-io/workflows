"""Sends the results report.py read to Dash0 as OTLP/HTTP JSON: one trace per
report, with a root span for the suite and a span per test.

Optional and bounded: without an endpoint and headers it writes one summary
line and stops, and a failed request ends in a warning, never a failed step.
It sends names, outcomes and durations, never test output, for the same reason
the check run carries none: nothing masks what leaves the runner through an API.

Attribute keys match the Playwright reporters' (storefront and backoffice E2E),
so one dashboard over `dash0.spans` covers every suite. JUnit has durations but
no start times, so each test span ends when the report runs.
"""

import gzip
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# A request's spans; Dash0 takes far more, this keeps each body small.
BATCH = 1000
# Passing tests beyond this are left out; failures always go.
MAX_TESTS = 20000
# The whole export, every request included, stays within this.
DEADLINE_SECS = 45
SCOPE = "understory-test-report"

env = os.environ.get


def traces_url(value):
    """The OTLP/HTTP traces URL. Takes Dash0's HTTP endpoint or its gRPC one
    (`ingress.<region>.aws.dash0.com:4317`), as the org-level secret holds
    only that: both are the same host, with OTLP/HTTP on 443."""
    value = value.strip()
    url = urllib.parse.urlsplit(value if "://" in value else f"grpc://{value}")
    if url.scheme == "grpc" or url.port == 4317:
        return f"https://{url.hostname}/v1/traces"
    path = url.path.rstrip("/")
    if not path.endswith("/v1/traces"):
        path += "/v1/traces"
    return urllib.parse.urlunsplit((url.scheme, url.netloc, path, "", ""))


def parse_headers(value):
    """`OTEL_EXPORTER_OTLP_HEADERS` format: comma-separated `key=value`, values URL-encoded."""
    headers = {}
    for pair in value.split(","):
        key, sep, val = pair.partition("=")
        if sep and key.strip():
            headers[key.strip()] = urllib.parse.unquote(val.strip())
    return headers


def attribute(key, value):
    if isinstance(value, bool):
        typed = {"boolValue": value}
    elif isinstance(value, int):
        typed = {"intValue": str(value)}
    else:
        typed = {"stringValue": str(value)}
    return {"key": key, "value": typed}


def attributes(values):
    return [attribute(k, v) for k, v in values.items() if v not in (None, "")]


def resource(title):
    repo = env("GITHUB_REPOSITORY", "")
    server = env("GITHUB_SERVER_URL", "https://github.com")
    run_id = env("GITHUB_RUN_ID", "")
    return attributes({
        "service.name": f"{repo.rsplit('/', 1)[-1] or 'unknown'}-tests",
        "service.namespace": "understory",
        "test.suite": title,
        "github.repository": repo,
        # A PR run's ref is `<n>/merge`; the branch is the head ref.
        "github.branch": env("GITHUB_HEAD_REF") or env("GITHUB_REF_NAME"),
        "github.sha": env("HEAD_SHA") or env("GITHUB_SHA"),
        "github.pr_number": env("PR"),
        "github.event_name": env("GITHUB_EVENT_NAME"),
        "github.workflow": env("GITHUB_WORKFLOW"),
        "github.job": env("GITHUB_JOB"),
        "github.run_id": run_id,
        "github.run_attempt": env("GITHUB_RUN_ATTEMPT"),
        "github.run_url": f"{server}/{repo}/actions/runs/{run_id}" if run_id else "",
    })


OUTCOME = {"passed": "expected", "failed": "unexpected", "skipped": "skipped"}


def test_span(case, trace_id, parent_id, end_ns):
    full_name = f"{case['package']} › {case['name']}" if case["name"] else case["package"]
    span = {
        "traceId": trace_id,
        "spanId": secrets.token_hex(8),
        "parentSpanId": parent_id,
        "name": full_name,
        "kind": 1,
        "startTimeUnixNano": str(end_ns - int(case["secs"] * 1e9)),
        "endTimeUnixNano": str(end_ns),
        "attributes": attributes({
            "test.name": case["name"] or "(package)",
            "test.full_name": full_name,
            "test.package": case["package"],
            "test.file": case["file"],
            "test.line": int(case["line"]) if case["line"] else None,
            "test.outcome": OUTCOME[case["status"]],
            "test.status": case["status"],
            "test.retries": 0,
            "test.is_flaky": False,
            "test.duration_ms": int(case["secs"] * 1000),
        }),
    }
    if case["status"] == "failed":
        span["status"] = {"code": 2}
    return span


def spans(results, end_ns):
    """The root span first, then the tests: every failure, and passing and
    skipped tests up to MAX_TESTS in all."""
    cases = results["cases"]
    failed = [c for c in cases if c["status"] == "failed"]
    others = [c for c in cases if c["status"] != "failed"][:max(0, MAX_TESTS - len(failed))]
    trace_id, root_id = secrets.token_hex(16), secrets.token_hex(8)
    longest = max((c["secs"] for c in cases), default=0)
    root = {
        "traceId": trace_id,
        "spanId": root_id,
        "name": results["title"],
        "kind": 1,
        "startTimeUnixNano": str(end_ns - int(longest * 1e9)),
        "endTimeUnixNano": str(end_ns),
        "attributes": attributes({
            "test.suite.tests": len(cases),
            "test.suite.failed": len(failed),
            "test.suite.skipped": sum(1 for c in cases if c["status"] == "skipped"),
        }),
    }
    if failed:
        root["status"] = {"code": 2}
    tests = [test_span(c, trace_id, root_id, end_ns) for c in failed + others]
    return trace_id, [root] + tests, len(cases) - len(failed) - len(others)


def post(url, headers, body, timeout):
    request = urllib.request.Request(
        url,
        method="POST",
        data=gzip.compress(json.dumps(body).encode()),
        headers={**headers, "Content-Type": "application/json", "Content-Encoding": "gzip"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        response.read()


def export(results, url, headers):
    """Returns the trace id, the spans sent and the tests left out."""
    deadline = time.monotonic() + DEADLINE_SECS
    trace_id, all_spans, left_out = spans(results, time.time_ns())
    res = {"attributes": resource(results["title"])}
    for i in range(0, len(all_spans), BATCH):
        remaining = deadline - time.monotonic()
        if remaining <= 1:
            raise TimeoutError(f"stopped after {i} of {len(all_spans)} spans, at the {DEADLINE_SECS}s limit")
        post(url, headers, {"resourceSpans": [{
            "resource": res,
            "scopeSpans": [{"scope": {"name": SCOPE}, "spans": all_spans[i:i + BATCH]}],
        }]}, min(15, remaining))
    return trace_id, len(all_spans) - 1, left_out


def main():
    endpoint, header_value = env("OTLP_ENDPOINT", ""), env("OTLP_HEADERS", "")
    if not endpoint or not header_value:
        line = "Dash0: not sent, as the caller passed no `otlp-endpoint` and `otlp-headers` (the `DASH0_OTLP_*` secrets)."
    else:
        try:
            with open(env("RESULTS", ""), encoding="utf-8") as f:
                results = json.load(f)
            trace_id, sent, left_out = export(results, traces_url(endpoint), parse_headers(header_value))
            line = f"Dash0: sent {sent} test results, trace `{trace_id}`."
            if left_out:
                line += f" {left_out} passing tests over the {MAX_TESTS} limit were left out."
        except (urllib.error.URLError, OSError, ValueError, KeyError, TimeoutError) as err:
            # HTTPError's text is the status line; the request headers never reach it.
            reason = f"HTTP {err.code}" if isinstance(err, urllib.error.HTTPError) else type(err).__name__
            detail = "" if isinstance(err, urllib.error.HTTPError) else f": {getattr(err, 'reason', err)}"
            line = f"Dash0: could not send the test results ({reason}{detail})."
            print(f"::warning::{line}")
    with open(env("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as out:
        out.write(f"{line}\n")


if __name__ == "__main__":
    sys.exit(main())
