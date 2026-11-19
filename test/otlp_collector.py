"""A local OTLP/HTTP collector for test-report-selftest.yml: appends each
request's path, Authorization header and decoded body to a JSON-lines file.

Run: python3 test/otlp_collector.py <port> <file>
"""

import gzip
import http.server
import json
import socketserver
import sys

PORT, OUT = int(sys.argv[1]), sys.argv[2]


class Collector(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        with open(OUT, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "body": json.loads(gzip.decompress(body)),
            }) + "\n")
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


class Server(http.server.HTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


Server(("127.0.0.1", PORT), Collector).serve_forever()
