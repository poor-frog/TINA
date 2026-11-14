"""Public read-only Agent Reach boundary, executed in a disposable subprocess."""
import json
import sys

from agent_reach.channels.github import GitHubChannel
from agent_reach.channels.web import WebChannel
from agent_reach.runtime.dispatch import run_action
from agent_reach.utils.url import normalize_public_http_url

REVISION = 'c70ae6da5d39bc90e09ad2ae0575ccc89f31e284'


def execute(body):
    channel = GitHubChannel() if body['channel'] == 'github' else WebChannel()
    params = {'query': body['query'], 'limit': 5} if body['action'] == 'search' else {'target': body['query']}
    # The GitHub public API runs without gh, account cookies, browser sessions or provider keys.
    backend = 'github-api' if body['channel'] == 'github' else None
    result = run_action(channel, body['action'], params, timeout=20, only_backend=backend)
    items = []
    for item in result.get('items', [])[:5]:
        try:
            url = normalize_public_http_url(item.get('url', ''))
        except ValueError:
            continue
        if not item.get('text'):
            continue
        items.append({'title': str(item.get('title') or url)[:300], 'url': url,
                      'text': str(item['text'])[:5000],
                      'author': str(item.get('author') or '')[:200],
                      'published_at': str(item.get('published_at') or '')[:100]})
    error = result.get('error') or {}
    return {'ok': result.get('ok') is True, 'channel': body['channel'], 'action': body['action'],
            'backend': result.get('backend'), 'items': items,
            'error': None if result.get('ok') is True else {'code': error.get('code', 'UPSTREAM_BROKEN')}}


if __name__ == '__main__':
    print(json.dumps(execute(json.load(sys.stdin)), ensure_ascii=False))
