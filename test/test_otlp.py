"""test-report's Dash0 export: report.py's results through otlp.py to a local OTLP server.

Run: python3 -m unittest discover -s test -p 'test_otlp.py'
"""

import gzip
import http.server
import importlib.util
import json
import os
import subprocess
import sys
import socketserver
import tempfile
import threading
import unittest

ACTION = os.path.join(os.path.dirname(__file__), "..", ".github", "actions", "test-report")

spec = importlib.util.spec_from_file_location("otlp", os.path.join(ACTION, "otlp.py"))
otlp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(otlp)

JUNIT = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="src/a.spec.ts">
    <testcase classname="src/a.spec.ts" name="adds" time="0.25"/>
    <testcase classname="src/a.spec.ts" name="subtracts" time="1.5"><failure message="no">expected 1</failure></testcase>
    <testcase classname="src/a.spec.ts" name="later" time="0"><skipped/></testcase>
  </testsuite>
</testsuites>
"""


class Collector(http.server.BaseHTTPRequestHandler):
    requests = []
    status = 200

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path != "/v1/traces":
            # report.py's check and comment: denied, as for a token without the permission.
            return self.do_GET()
        Collector.requests.append((self.path, dict(self.headers), json.loads(gzip.decompress(body))))
        self.send_response(Collector.status)
        self.end_headers()

    def do_GET(self):
        self.send_response(403)
        self.end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer's own looks up the host's name, which can take 30s on a Mac.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def values(attrs):
    return {a["key"]: next(iter(a["value"].values())) for a in attrs}


class Endpoint(unittest.TestCase):
    def test_grpc_endpoint_becomes_https_on_the_same_host(self):
        for grpc in ("ingress.eu-west-1.aws.dash0.com:4317", "https://ingress.eu-west-1.aws.dash0.com:4317",
                     "grpc://ingress.eu-west-1.aws.dash0.com:4317"):
            self.assertEqual(otlp.traces_url(grpc), "https://ingress.eu-west-1.aws.dash0.com/v1/traces")

    def test_http_endpoint_gets_the_traces_path_once(self):
        self.assertEqual(otlp.traces_url("https://ingress.eu-west-1.aws.dash0.com/"),
                         "https://ingress.eu-west-1.aws.dash0.com/v1/traces")
        self.assertEqual(otlp.traces_url("http://localhost:4318/v1/traces"), "http://localhost:4318/v1/traces")

    def test_headers_are_split_and_url_decoded(self):
        self.assertEqual(otlp.parse_headers("Authorization=Bearer%20abc, Dash0-Dataset=default,junk"),
                         {"Authorization": "Bearer abc", "Dash0-Dataset": "default"})


class Export(unittest.TestCase):
    def setUp(self):
        Collector.requests, Collector.status = [], 200
        self.server = Server(("127.0.0.1", 0), Collector)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.tmp = tempfile.TemporaryDirectory()
        self.summary = os.path.join(self.tmp.name, "summary.md")
        self.env = {
            "PATH": os.environ["PATH"],
            "GITHUB_REPOSITORY": "understory-io/storefront",
            "GITHUB_SERVER_URL": "https://github.com",
            "GITHUB_RUN_ID": "42",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_HEAD_REF": "feature/x",
            "GITHUB_REF_NAME": "7/merge",
            "GITHUB_EVENT_NAME": "pull_request",
            "GITHUB_STEP_SUMMARY": self.summary,
            "GITHUB_OUTPUT": os.path.join(self.tmp.name, "output"),
            "GITHUB_WORKSPACE": self.tmp.name,
            "HEAD_SHA": "a" * 40,
            "PR": "7",
            "TITLE": "Tests (storefront)",
        }

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def report(self):
        junit = os.path.join(self.tmp.name, "junit.xml")
        with open(junit, "w") as f:
            f.write(JUNIT)
        env = {**self.env, "JUNIT_PATH": junit, "WORK_DIR": self.tmp.name, "TOKEN": "",
               "GITHUB_API_URL": f"http://127.0.0.1:{self.server.server_port}"}
        subprocess.run([sys.executable, "-I", os.path.join(ACTION, "report.py")], env=env, check=True,
                       capture_output=True)
        with open(self.env["GITHUB_OUTPUT"]) as f:
            return dict(line.split("=", 1) for line in f.read().splitlines() if "=" in line)["results"]

    def send(self, results, endpoint, headers="Authorization=Bearer%20secret-token,Dash0-Dataset=default"):
        env = {**self.env, "RESULTS": results, "OTLP_ENDPOINT": endpoint, "OTLP_HEADERS": headers}
        return subprocess.run([sys.executable, "-I", os.path.join(ACTION, "otlp.py")], env=env, check=True,
                              capture_output=True, text=True)

    def summary_text(self):
        with open(self.summary) as f:
            return f.read()

    def test_one_trace_with_a_span_per_test(self):
        self.send(self.report(), f"http://127.0.0.1:{self.server.server_port}")
        [(path, headers, body)] = Collector.requests
        self.assertEqual(path, "/v1/traces")
        self.assertEqual(headers["Authorization"], "Bearer secret-token")
        self.assertEqual(headers["Dash0-Dataset"], "default")
        [resource_spans] = body["resourceSpans"]
        resource = values(resource_spans["resource"]["attributes"])
        self.assertEqual(resource["service.name"], "storefront-tests")
        self.assertEqual(resource["test.suite"], "Tests (storefront)")
        self.assertEqual(resource["github.repository"], "understory-io/storefront")
        self.assertEqual(resource["github.branch"], "feature/x")
        self.assertEqual(resource["github.pr_number"], "7")
        self.assertEqual(resource["github.run_url"], "https://github.com/understory-io/storefront/actions/runs/42")
        self.assertEqual(resource["github.run_attempt"], "2")
        self.assertEqual(resource["github.sha"], "a" * 40)
        root, *tests = resource_spans["scopeSpans"][0]["spans"]
        self.assertEqual(root["name"], "Tests (storefront)")
        self.assertEqual(root["status"], {"code": 2})
        self.assertEqual({s["traceId"] for s in tests}, {root["traceId"]})
        self.assertEqual({s["parentSpanId"] for s in tests}, {root["spanId"]})
        by_name = {values(s["attributes"])["test.name"]: s for s in tests}
        failed = values(by_name["subtracts"]["attributes"])
        self.assertEqual(failed["test.outcome"], "unexpected")
        self.assertEqual(failed["test.status"], "failed")
        self.assertEqual(failed["test.duration_ms"], "1500")
        self.assertEqual(by_name["subtracts"]["status"], {"code": 2})
        self.assertEqual(values(by_name["adds"]["attributes"])["test.outcome"], "expected")
        self.assertEqual(values(by_name["later"]["attributes"])["test.outcome"], "skipped")
        # The failure's output stays on the runner.
        self.assertNotIn("expected 1", json.dumps(body))
        self.assertIn("sent 3 test results", self.summary_text())

    def test_without_secrets_nothing_is_sent_and_the_summary_says_so(self):
        self.send(self.report(), "", headers="")
        self.assertEqual(Collector.requests, [])
        self.assertIn("not sent", self.summary_text())

    def test_a_rejected_request_warns_without_the_headers(self):
        Collector.status = 401
        run = self.send(self.report(), f"http://127.0.0.1:{self.server.server_port}")
        self.assertIn("::warning::Dash0: could not send the test results (HTTP 401)", run.stdout)
        self.assertNotIn("secret-token", run.stdout + run.stderr + self.summary_text())

    def test_an_unreachable_endpoint_warns(self):
        run = self.send(self.report(), "http://127.0.0.1:1")
        self.assertIn("::warning::Dash0: could not send", run.stdout)

    def test_no_results_file_when_the_report_has_a_problem(self):
        env = {**self.env, "JUNIT_PATH": os.path.join(self.tmp.name, "missing.xml"), "WORK_DIR": self.tmp.name,
               "TOKEN": ""}
        subprocess.run([sys.executable, "-I", os.path.join(ACTION, "report.py")], env=env, check=True,
                       capture_output=True)
        with open(self.env["GITHUB_OUTPUT"]) as f:
            self.assertIn("results=\n", f.read())


if __name__ == "__main__":
    unittest.main()
