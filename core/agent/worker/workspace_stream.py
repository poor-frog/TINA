"""A loopback stream transport for an isolated staging workspace worker."""
import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote
from urllib.request import Request, urlopen

PORT = 8721


def topics(owner, unit):
    if not re.fullmatch(r'[1-9][0-9]*', owner) or not re.fullmatch(
        rf'agent-{owner}-(?:chat-[A-Za-z0-9._-]{{1,90}}|scheduled-[0-9a-f]{{10}})', unit
    ):
        raise ValueError('Invalid account or workload')
    return f'unit:{unit}:in', f'unit:{unit}:out'


class WorkspaceStream:
    """Only the Redis calls used by worker.engine.serve cross the sidecar boundary."""

    def __init__(self, owner, unit):
        self.inbox, self.outbox = topics(owner, unit)

    def _request(self, path, data):
        req = Request(f'http://127.0.0.1:{PORT}/{path}', data=json.dumps(data).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
        with urlopen(req, timeout=25) as response:
            return json.load(response)

    def xadd(self, name, fields):
        if name != self.outbox or set(fields) != {'event'}:
            raise ValueError('Invalid worker output')
        return self._request('event', fields)

    def xrevrange(self, name, count=1):
        if name != self.inbox or count != 1:
            raise ValueError('Invalid worker input')
        return self._request('tail', {})

    def xread(self, streams, count=1, block=None):
        if set(streams) != {self.inbox} or count != 1:
            raise ValueError('Invalid worker input')
        deadline = time.monotonic() + max(0.001, (block or 1) / 1000)
        while True:
            remaining = max(1, int((deadline - time.monotonic()) * 1000))
            rows = self._request('read', {'after': streams[self.inbox], 'ms': min(15000, remaining)})
            if rows or time.monotonic() >= deadline:
                return rows


def handler_for(client, inbox, outbox):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Messages, tokens and tool payloads do not belong in logs.

        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 1024 * 1024:
                    self.send_error(413)
                    return
                data = json.loads(self.rfile.read(size))
                if self.path == '/tail' and data == {}:
                    result = client.xrevrange(inbox, count=1)
                elif (self.path == '/read' and isinstance(data, dict) and set(data) == {'after', 'ms'}
                      and re.fullmatch(r'(?:\$|[0-9]{1,20}-[0-9]{1,20})', str(data['after']))
                      and type(data['ms']) is int and 1 <= data['ms'] <= 15000):
                    result = client.xread({inbox: data['after']}, count=1, block=data['ms'])
                elif (self.path == '/event' and isinstance(data, dict) and set(data) == {'event'}
                      and isinstance(data['event'], str) and isinstance(json.loads(data['event']), dict)):
                    result = client.xadd(outbox, data)
                else:
                    self.send_error(400)
                    return
            except (ValueError, TypeError, UnicodeError):
                self.send_error(400)
                return
            except Exception:
                self.send_error(503)
                return
            raw = json.dumps(result).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    return Handler


def main():
    import redis
    inbox, outbox = topics(os.environ['TINA_OWNER'], os.environ['TINA_UNIT_ID'])
    password = quote(os.environ.pop('VALKEY_PASSWORD'), safe='')
    url = f"rediss://:{password}@{os.environ['VALKEY_HOST']}:6379/0?ssl_check_hostname=True&ssl_cert_reqs=required"
    with redis.from_url(url, decode_responses=True, socket_timeout=20, socket_connect_timeout=3) as client:
        client.ping()
        with ThreadingHTTPServer(('127.0.0.1', PORT), handler_for(client, inbox, outbox)) as server:
            server.serve_forever()


if __name__ == '__main__':
    main()
