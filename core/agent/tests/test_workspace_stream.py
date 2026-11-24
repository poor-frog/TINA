import json
import threading
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import fakeredis
import pytest
from worker.workspace_stream import handler_for, topics


def test_sidecar_only_serves_its_two_topics():
    client = fakeredis.FakeRedis(decode_responses=True)
    inbox, outbox = topics('2', 'agent-2-chat-main')
    with pytest.raises(ValueError):
        topics('5', 'agent-2-chat-main')
    with ThreadingHTTPServer(('127.0.0.1', 0), handler_for(client, inbox, outbox)) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def post(path, data):
            request = Request(f'http://127.0.0.1:{server.server_port}/{path}', data=json.dumps(data).encode())
            with urlopen(request, timeout=3) as result:
                return json.load(result)
        try:
            client.xadd(inbox, {'turn':'owned'})
            assert post('tail', {})[0][1] == {'turn':'owned'}
            assert post('read', {'after':'0-0', 'ms':1})[0][0] == inbox
            post('event', {'event':'{"type":"turn-complete"}'})
            assert client.xlen(outbox) == 1
            with pytest.raises(HTTPError) as exc:
                post('read', {'after':'0-0','ms':1,'key':'unit:agent-5-chat-main:in'})
            assert exc.value.code == 400
        finally:
            server.shutdown()
            thread.join()
