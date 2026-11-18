"""Exercise real Codex request construction against a local Responses fixture, without credentials."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from llm.codex import CodexHarness


def main():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            has_web = any(tool.get('type') == 'web_search' for tool in requests[-1]['tools'])
            text = 'WEB_WIRE_OK' + (' citeturn0search0' if has_web else '')
            if requests[-1].get('text', {}).get('format', {}).get('type') == 'json_schema':
                text = '{"tool_calls":[]}'
            message = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant',
                       'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
            events = [
                {'type': 'response.created', 'response': {'id': 'resp_fixture', 'status': 'in_progress', 'output': []}},
                {'type': 'response.output_item.added', 'output_index': 0, 'item': message},
                {'type': 'response.output_text.delta', 'item_id': message['id'], 'output_index': 0,
                 'content_index': 0, 'delta': text},
                {'type': 'response.output_item.done', 'output_index': 0, 'item': message},
                {'type': 'response.completed', 'response': {'id': 'resp_fixture', 'status': 'completed',
                 'output': [message], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}},
            ]
            if has_web:
                opened = {'id': 'web_fixture', 'type': 'web_search_call', 'status': 'completed',
                          'action': {'type': 'open_page', 'url': 'https://docs.python.org/3/library/pathlib.html'}}
                events.insert(1, {'type': 'response.output_item.added', 'output_index': 0, 'item': opened})
                events.insert(2, {'type': 'response.output_item.done', 'output_index': 0, 'item': opened})
            body = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    class Harness(CodexHarness):
        def _argv(self, *args, **kwargs):
            return [
                f'model_providers.openai_api_key.base_url="http://127.0.0.1:{server.server_port}/v1"'
                if arg.startswith('model_providers.openai_api_key.base_url=') else arg
                for arg in super()._argv(*args, **kwargs)
            ]

    os.environ.update(OPENAI_API_KEY='fixture-no-model', TINA_CODEX_AUTH_MODE='api-key')
    try:
        with tempfile.TemporaryDirectory(prefix='codex-web-smoke-', dir='/work') as temporary:
            work = Path(temporary)
            os.environ['TINA_MOUNTS'] = json.dumps([{'path': str(work), 'write': True}])
            harness = Harness()
            harness.prepare(work)
            session = None
            for trigger, tools, mode in [
                ('message', ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch'], 'live'),
                ('message', ['Read', 'Write', 'WebSearch'], 'cached'),
                ('message', ['Read', 'Write', 'Bash'], 'disabled'),
                ('event', ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch'], 'disabled'),
            ]:
                os.environ['TINA_UNIT_TRIGGER'] = trigger
                previous = len(requests)
                events = list(harness.run_turn(work, 'Return WEB_WIRE_OK', allowed_tools=tools,
                                               model='gpt-5.4', session=session))
                assert events[-1].get('ok'), events[-1].get('reply')
                assert len(requests) > previous, 'Codex did not call the fixture'
                searches = [tool for tool in requests[-1]['tools'] if tool.get('type') == 'web_search']
                if mode == 'disabled':
                    assert not searches, 'ungranted web search reached the provider'
                else:
                    assert len(searches) == 1
                    assert searches[0]['external_web_access'] is (mode == 'live')
                    assert 'https://docs.python.org/3/library/pathlib.html' in events[-1]['reply']
                    assert 'cite' not in events[-1]['reply']
                    stored = list((work / '.codex/tina-sources' / events[-1]['sessionId']).glob('*.json'))
                    assert stored and any(json.loads(path.read_text())[0]['url'].startswith('https://docs.python.org/') for path in stored)
                session = events[-1]['sessionId']
                print(f'PASS {trigger} {mode} web tool on {"new" if previous == 0 else "resumed"} thread', flush=True)
            schema = {'type':'object','properties':{'tool_calls':{'type':'array','items':{'type':'string'}}},
                      'required':['tool_calls'],'additionalProperties':False}
            events = list(harness.run_turn(work, 'Return an empty tool_calls array.', allowed_tools=(),
                                           model='gpt-5.4', output_schema=schema))
            assert events[-1].get('ok') and json.loads(events[-1]['reply']) == {'tool_calls':[]}
            assert requests[-1]['text']['format']['schema'] == schema
            assert not any(t.get('type') == 'web_search' or t.get('name') in (
                'exec_command','shell_command','shell','write_stdin') for t in requests[-1]['tools'])
            print('PASS voice outputSchema reaches real Codex Responses request; final JSON is intact', flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
