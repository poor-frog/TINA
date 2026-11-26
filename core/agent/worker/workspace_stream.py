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
        rf'(?:agent-{owner}-(?:chat-[A-Za-z0-9._-]{{1,90}}|scheduled-[0-9a-f]{{10}})|agent-meet-[1-9][0-9]*)', unit
    ):
        raise ValueError('Invalid account or workload')
    return f'unit:{unit}:in', f'unit:{unit}:out'


def meeting_topics(transcript_stream, meeting_numeric_id):
    if not transcript_stream and not meeting_numeric_id:
        return None, None, None
    row_id = str(meeting_numeric_id or '')
    if not re.fullmatch(r'[1-9][0-9]*', row_id) or transcript_stream != f'tc:meeting:{row_id}':
        raise ValueError('Invalid meeting stream binding')
    return transcript_stream, f'proc:meeting:{row_id}', f'proc:meeting:{row_id}:cursor'


class WorkspaceStream:
    """Only the Redis calls used by worker.engine.serve and serve_meeting cross the sidecar boundary."""

    def __init__(self, owner, unit, *, transcript_stream=None, meeting_numeric_id=None):
        self.inbox, self.outbox = topics(owner, unit)
        self.transcript_stream, self.proc_stream, self.cursor_key = meeting_topics(
            transcript_stream if transcript_stream is not None else os.environ.get('TINA_TRANSCRIPT_STREAM'),
            meeting_numeric_id if meeting_numeric_id is not None else os.environ.get('TINA_MEETING_NUMERIC_ID'),
        )

    def _request(self, path, data):
        req = Request(f'http://127.0.0.1:{PORT}/{path}', data=json.dumps(data).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
        with urlopen(req, timeout=25) as response:
            return json.load(response)

    def xadd(self, name, fields):
        if name == self.outbox and set(fields) == {'event'}:
            return self._request('event', fields)
        if self.proc_stream and name == self.proc_stream and isinstance(fields, dict) and fields:
            return self._request('meeting-proc', {'fields': fields})
        raise ValueError('Invalid worker output')

    def set(self, name, value):
        if not self.cursor_key or name != self.cursor_key:
            raise ValueError('Invalid worker cursor')
        return self._request('meeting-cursor', {'value': str(value)})

    def xrevrange(self, name, count=1):
        if name != self.inbox or count != 1:
            raise ValueError('Invalid worker input')
        return self._request('tail', {})

    def xread(self, streams, count=1, block=None):
        if set(streams) == {self.inbox} and count == 1:
            path, stream_name = 'read', self.inbox
        elif self.transcript_stream and set(streams) == {self.transcript_stream} and 1 <= int(count) <= 50:
            path, stream_name = 'meeting-read', self.transcript_stream
        else:
            raise ValueError('Invalid worker input')
        deadline = time.monotonic() + max(0.001, (block or 1) / 1000)
        while True:
            remaining = max(1, int((deadline - time.monotonic()) * 1000))
            payload = {'after': streams[stream_name], 'ms': min(15000, remaining)}
            if path == 'meeting-read':
                payload['count'] = int(count)
            rows = self._request(path, payload)
            if rows or time.monotonic() >= deadline:
                return rows


def handler_for(client, inbox, outbox, *, transcript_stream=None, proc_stream=None, cursor_key=None):
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
                elif (transcript_stream and self.path == '/meeting-read'
                      and isinstance(data, dict) and set(data) == {'after', 'ms', 'count'}
                      and re.fullmatch(r'(?:0|\$|[0-9]{1,20}-[0-9]{1,20})', str(data['after']))
                      and type(data['ms']) is int and 1 <= data['ms'] <= 15000
                      and type(data['count']) is int and 1 <= data['count'] <= 50):
                    result = client.xread({transcript_stream: data['after']}, count=data['count'], block=data['ms'])
                elif (proc_stream and self.path == '/meeting-proc'
                      and isinstance(data, dict) and set(data) == {'fields'}
                      and isinstance(data['fields'], dict) and 1 <= len(data['fields']) <= 6
                      and all(k in {'note', 'params', 'type', 'cursor'} and isinstance(v, str)
                              for k, v in data['fields'].items())):
                    result = client.xadd(proc_stream, data['fields'])
                elif (cursor_key and self.path == '/meeting-cursor'
                      and isinstance(data, dict) and set(data) == {'value'}
                      and re.fullmatch(r'[0-9]{1,20}-[0-9]{1,20}', str(data['value']))):
                    result = bool(client.set(cursor_key, str(data['value'])))
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
    transcript_stream, proc_stream, cursor_key = meeting_topics(
        os.environ.get('TINA_TRANSCRIPT_STREAM'), os.environ.get('TINA_MEETING_NUMERIC_ID'),
    )
    password = quote(os.environ.pop('VALKEY_PASSWORD'), safe='')
    url = f"rediss://:{password}@{os.environ['VALKEY_HOST']}:6379/0?ssl_check_hostname=True&ssl_cert_reqs=required"
    with redis.from_url(url, decode_responses=True, socket_timeout=20, socket_connect_timeout=3) as client:
        client.ping()
        handler = handler_for(
            client, inbox, outbox,
            transcript_stream=transcript_stream, proc_stream=proc_stream, cursor_key=cursor_key,
        )
        with ThreadingHTTPServer(('127.0.0.1', PORT), handler) as server:
            server.serve_forever()


if __name__ == '__main__':
    main()
