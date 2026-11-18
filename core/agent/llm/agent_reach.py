"""Bounded public retrieval client; never includes meeting or workspace context."""
import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait
from contextvars import copy_context
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
                    raise LLMError('Public retrieval is unavailable',status_code=response.status_code)
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
    except (httpx.HTTPError, ValueError, TypeError, AttributeError) as exc:
        raise LLMError('Public retrieval returned no usable response') from exc


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


def answer_public(question, complete, review, *, refine=None, current=lambda: True, deadline=None):
    from shared.voice_knowledge import validate_voice_answer, verify_voice_reply
    from shared.voice_trace import voice_span, voice_trace_id, log as voice_log
    deadline = min(deadline if deadline is not None else float('inf'), time.monotonic() + 50)
    sources = []
    rounds = pages_read = pages_failed = 0
    def remaining():
        if current() is False: raise RuntimeError('Voice turn cancelled')
        value = deadline - time.monotonic()
        if value <= 0: raise TimeoutError('Public retrieval budget exhausted')
        return value

    def retrieve(operation):
        with voice_span('web_retrieve'):
            value = query(*operation, timeout=min(10, remaining()))
        remaining()
        return value

    def read_pages(items):
        nonlocal pages_read, pages_failed
        # Two reads match the shared retrieval service's two subprocess slots.
        targets = [item for item in items if item['url'] not in attempted][:min(2, 3-len(attempted))]
        if not targets: return
        remaining()
        pool = ThreadPoolExecutor(max_workers=2)
        before = pages_read
        try:
            with voice_span('web_read') as metrics:
                attempted.update(item['url'] for item in targets)
                tasks = {pool.submit(copy_context().run, retrieve, public_request(item['url'])):item for item in targets}
                pending = set(tasks)
                while pending:
                    remaining()
                    done, pending = wait(pending, timeout=min(.1, remaining()))
                    for task in done:
                        item = tasks[task]
                        try: result = task.result()
                        except LLMError:
                            pages_failed += 1
                            continue
                        page = next((p for p in result['items'] if p['url'] == item['url']), None) if result['ok'] else None
                        if page:
                            item.update(page)
                            pages_read += 1
                        else: pages_failed += 1
                metrics.update(input_sources=len(targets), output_sources=pages_read-before)
        finally:
            # In-flight HTTP reads are bounded; Stop fences their results and all subsequent calls.
            pool.shutdown(wait=False, cancel_futures=True)

    def result_for(reason, *, verification=(), body=None, retrieval_error=None):
        remaining()
        record = {'type':'voice_web_result','request_id':voice_trace_id.get(),'reason':reason,
                  'retrieved_sources':len(sources),'verification':list(verification),
                  'search_rounds':rounds,'pages_read':pages_read,'pages_failed':pages_failed}
        if retrieval_error in {'RATE_LIMITED','TIMEOUT','NEED_LOGIN','NEED_SETUP','NOT_FOUND','BAD_INPUT','UPSTREAM_BROKEN','PLATFORM_BLOCKED'}:
            record['retrieval_error'] = retrieval_error
        voice_log.info('%s',json.dumps(record))
        return body if body is not None else {'reason':reason, **({'verification':list(verification)} if verification else {})}
    operation = public_request(question)
    try: result = retrieve(operation)
    except LLMError as exc:
        code = ('TIMEOUT' if isinstance(exc.__cause__,httpx.TimeoutException) else
                {429:'RATE_LIMITED',408:'TIMEOUT',504:'TIMEOUT',404:'NOT_FOUND',403:'PLATFORM_BLOCKED'}.get(exc.status_code,'UPSTREAM_BROKEN'))
        return result_for('web_unavailable',retrieval_error=code)
    if not result['ok']:
        return result_for('web_unavailable',retrieval_error=(result.get('error') or {}).get('code'))
    items, attempted, seen_queries = {}, set(), {operation[2].casefold()}
    for round_index in range(2):
        rounds = round_index + 1
        fresh = []
        for item in result['items']:
            if item['url'] not in items and len(items) < 6:
                items[item['url']] = dict(item)
                fresh.append(items[item['url']])
        if operation[1] == 'search': read_pages(fresh)
        sources = [{'id': f's{i}', 'title': item['title'], 'url': item['url'], 'quote': item['text']}
                   for i, item in enumerate(items.values())]
        remaining()
        if sources:
            prompt = json.dumps({'question': question, 'sources': sources}, ensure_ascii=False)
            try: raw = complete(prompt)
            except Exception:
                return result_for('llm_unavailable')
            remaining()
            try: proposed = validate_voice_answer(raw,sources)
            except (ValueError,TypeError,AttributeError):
                return result_for('generation_format_invalid')
            if proposed['claims']: break
        if round_index or refine is None or operation != ('web', 'search', question) or remaining() < 15:
            return result_for('web_answer_empty' if sources else 'web_no_sources')
        try:
            with voice_span('web_refine'):
                plan = json.loads(refine(json.dumps({'question':question,'sources':sources}, ensure_ascii=False)))
            remaining()
            refined = plan.get('query') if isinstance(plan, dict) and set(plan) == {'query'} else None
            if (not isinstance(refined,str) or not 1 <= len(refined.strip()) <= 200
                    or any(ord(c) < 32 or ord(c) == 127 for c in refined)
                    or refined.strip().casefold() in seen_queries):
                return result_for('web_answer_empty' if sources else 'web_no_sources')
            seen_queries.add(refined.strip().casefold())
            result = retrieve(('web','search',refined.strip()))
        except LLMError:
            return result_for('web_unavailable')
        except (ValueError,TypeError,AttributeError):
            return result_for('web_answer_empty' if sources else 'web_no_sources')
        if not result['ok']:
            return result_for('web_unavailable',retrieval_error=(result.get('error') or {}).get('code'))
    remaining()
    verified = json.loads(verify_voice_reply(raw,question,sources,review,diagnostics=True))
    remaining()
    checks = verified.get('verification',[])
    checked = validate_voice_answer(json.dumps(verified,ensure_ascii=False),sources)
    if not checked['claims']:
        reason = ('verification_unavailable' if verified.get('reason')=='verification_unavailable'
                  else 'web_numeric_mismatch' if 'numeric_mismatch' in checks else 'verification_rejected')
        return result_for(reason,verification=checks)
    return result_for('answered',verification=checks,body={
        'text':' '.join(c['text'] for c in checked['claims']),
        'links':[{k:s[k] for k in ('url','title')} for s in checked['sources']], 'verification':checks})
