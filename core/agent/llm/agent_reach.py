"""Bounded public retrieval client; never includes meeting or workspace context."""
import json
import os
import re
from urllib.parse import urlsplit

import httpx

from .citations import safe_web_source
from .errors import LLMError

TOOLS = {
    'reach_web_search': ('web', 'search', 'Search the public web. Supply only the public query explicitly requested by the user.'),
    'reach_web_read': ('web', 'read', 'Read a public HTTP(S) page. Supply its URL, never a local or private address.'),
    'reach_github_search': ('github', 'search', 'Search public GitHub repositories. Supply a public repository search query.'),
    'reach_github_read': ('github', 'read', 'Read a public GitHub README, issue or PR with comments. Supply owner/repo or a github.com URL.'),
}


def query(channel, action, text, *, timeout=26, transport=None):
    if channel not in ('web', 'github') or action not in ('search', 'read'):
        raise ValueError('Unsupported public retrieval operation')
    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or any(ord(c) < 32 for c in text):
        raise ValueError('Invalid public query')
    endpoint = os.environ.get('TINA_AGENT_REACH_URL', '').rstrip('/')
    if not endpoint:
        raise LLMError('Public retrieval is not configured')
    try:
        with httpx.Client(timeout=timeout, transport=transport, follow_redirects=False, trust_env=False) as client:
            with client.stream('POST', endpoint + '/query', json={'channel': channel, 'action': action, 'query': text}) as response:
                if response.status_code != 200:
                    raise LLMError('Public retrieval is unavailable')
                data = bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data) > 200000:
                        raise LLMError('Public retrieval exceeded its output bound')
        body = json.loads(data)
        if not isinstance(body, dict) or body.get('channel') != channel or body.get('action') != action:
            raise ValueError('Invalid retrieval envelope')
        if body.get('ok') is not True:
            code = (body.get('error') or {}).get('code')
            code = code if code in {'RATE_LIMITED','TIMEOUT','NEED_LOGIN','NEED_SETUP','NOT_FOUND','BAD_INPUT','UPSTREAM_BROKEN','PLATFORM_BLOCKED'} else 'UPSTREAM_BROKEN'
            return {'ok': False, 'items': [], 'error': {'code': code}}
        if not isinstance(body.get('items'), list) or len(body['items']) > 5:
            raise ValueError('Invalid retrieval items')
        items = []
        for value in body['items']:
            source = safe_web_source(value)
            if source and isinstance(value.get('text'), str) and value['text'].strip():
                items.append({k: source[k] for k in ('title','url')} | {'text': value['text'][:5000]})
        return {'ok': True, 'items': items, 'error': None}
    except (httpx.HTTPError, ValueError, TypeError, AttributeError):
        raise LLMError('Public retrieval returned no usable response') from None


def public_request(question):
    links = re.findall(r'https?://[^\s<>]+', question)
    if links:
        target = links[0].rstrip('.,!?')
        return ('github' if urlsplit(target).hostname in ('github.com','www.github.com') else 'web', 'read', target)
    match = re.match(r'^github\s*[:,-]?\s*(.+)$', question, re.I)
    if match:
        text = match[1].strip()
        if re.fullmatch(r'[\w.-]+/[\w.-]+(?:/(?:issues|pull)/\d+)?', text):
            return 'github', 'read', 'https://github.com/' + text
        return 'github', 'search', text
    return 'web', 'search', question


def answer_public(question, complete, review):
    from shared.voice_knowledge import validate_voice_answer, verify_voice_reply
    result = query(*public_request(question), timeout=15)
    if not result['ok']:
        return {'reason': 'web_unavailable'}
    sources = [{'id': f's{i}', 'title': item['title'], 'url': item['url'], 'quote': item['text']}
               for i, item in enumerate(result['items'])]
    if not sources:
        return {'reason': 'web_no_sources'}
    prompt = json.dumps({'question': question, 'sources': sources}, ensure_ascii=False)
    raw = complete(prompt)
    checked = validate_voice_answer(verify_voice_reply(raw, question, sources, review), sources)
    if not checked['claims']:
        return {'reason': 'web_no_sources'}
    return {'text': ' '.join(c['text'] for c in checked['claims']),
            'links': [{k: s[k] for k in ('url','title')} for s in checked['sources']]}
