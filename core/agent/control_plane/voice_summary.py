"""Bounded read-only whole-meeting recaps; partial preparation never masquerades as coverage."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import json
import re
from functools import partial
import threading
import time
from fastapi import HTTPException

from shared.meeting_knowledge import digest
from shared.voice_knowledge import validate_voice_answer, voice_failure, voice_sources
from shared.voice_summary import summary_parts

# shortcut: private RAM cache for the pilot; use a durable job store for multi-replica coordination.
_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix='voice-recap')
_slots = threading.BoundedSemaphore(3)
_lock = threading.Lock()
_cache = OrderedDict()


def map_part(complete, sources, question):
    raw = complete({'mode':'voice_summary_map','question':question, 'sources':sources})
    result = validate_voice_answer(raw, sources)
    if json.loads(raw).get('reason'):
        raise ValueError('A recap part could not be verified')
    return result['claims']


def _submit(key, work):
    with _lock:
        now = time.monotonic()
        for old, (created, future) in list(_cache.items()):
            if future.done() and (now-created >= 900 or future.exception() is not None): del _cache[old]
        if key in _cache:
            return _cache[key][1]
        while len(_cache) >= 512:
            victim = next((k for k, (_,f) in _cache.items() if f.done()), None)
            if victim is None: return None
            del _cache[victim]
        if not _slots.acquire(blocking=False): return None
        try:
            future = _pool.submit(work)
        except BaseException:
            _slots.release(); raise
        future.add_done_callback(lambda _: _slots.release())
        _cache[key] = (now, future)
        return future


def gather(jobs, deadline, current=None):
    completed, active = {}, {}
    next_job, checked_at = 0, -float('inf')
    while len(completed) < len(jobs):
        if current is not None and time.monotonic()-checked_at >= .25:
            current(); checked_at = time.monotonic()
        if time.monotonic() >= deadline: return None, len(completed)
        while next_job < len(jobs):
            key, work = jobs[next_job]
            future = _submit(key, work)
            if future is None: break
            active.setdefault(future, []).append(next_job); next_job += 1
            if not future.done() and sum(not f.done() for f in active) >= 3: break
        for future in list(active):
            if future.done():
                result = future.result()
                for index in active.pop(future): completed[index] = result
        if len(completed) == len(jobs): return [completed[i] for i in range(len(jobs))], len(completed)
        remaining = deadline - time.monotonic()
        if remaining <= 0: return None, len(completed)
        if not active:
            # Another recap may own all slots; wait inside this turn instead of asking for a repeat.
            time.sleep(min(remaining, .05))
            continue
        wait(active, timeout=min(remaining,.25), return_when=FIRST_COMPLETED)
    return [], 0


def pending(question, completed, total):
    english = bool(re.search(r'\b(?:summary|summari[sz]e|recap)\b', question.casefold()))
    text = ('The recap did not finish within the waiting limit. I do not have a fully verified summary yet.' if english else
            'Việc tổng hợp chưa hoàn tất trong thời gian chờ. Em chưa có bản tóm tắt đã được kiểm chứng.')
    return {'text':text,'sources':[],'answer_kind':'meeting','reason':'summary_pending'}


def recap(question, candidates, scope, complete, *, budget=120, current=None):
    deadline = time.monotonic() + budget
    sources = [s | {'id':f's{i}'} for i,s in enumerate(candidates)]
    parts = summary_parts(sources)
    if not parts: return voice_failure('no_shared_sources')
    def job(stage, payload, work):
        return (scope, stage, digest(payload)), work
    jobs = [job('map',[question,part],partial(map_part,complete,part,question)) for part in parts]
    try:
        mapped, count = gather(jobs, deadline, current)
    except Exception as exc:
        if isinstance(exc,HTTPException) and exc.status_code==409: raise
        return voice_failure('verification_unavailable')
    if mapped is None: return pending(question,count,len(parts))
    facts = [claim for group in mapped for claim in group]
    if not facts: return voice_failure('insufficient_evidence')
    # Reduce in bounded groups; summaries are navigation aids, final facts cite original chunks.
    while True:
        groups, group, size = [], [], 0
        for fact in facts:
            length = len(json.dumps(fact,ensure_ascii=False))
            if group and (len(group)>=24 or size+length>12000): groups.append(group); group=[]; size=0
            group.append(fact); size+=length
        if group: groups.append(group)
        def select(group):
            allowed = {i for fact in group for i in fact['source_ids']}
            rows = [s for s in sources if s['id'] in allowed]
            raw = complete({'mode':'voice_summary_select','question':question,'summary_facts':group})
            return validate_voice_answer(raw, rows)['claims']
        jobs = [job('select', [question,group], partial(select,group)) for group in groups]
        try: results, count = gather(jobs, deadline, current)
        except Exception as exc:
            if isinstance(exc,HTTPException) and exc.status_code==409: raise
            return voice_failure('llm_unavailable')
        if results is None: return pending(question,count,len(groups))
        facts = [claim for result in results for claim in result]
        if len(groups)==1: break
        if not facts: return voice_failure('insufficient_evidence')
    used = {i for claim in facts for i in claim['source_ids']}
    evidence = [s for s in sources if s['id'] in used]
    # Include related original passages so review can catch a later correction or disagreement.
    nearby, _ = voice_sources([s for s in sources if s['kind']=='transcript'],
                               ' '.join(c['text'] for c in facts), [], int(time.time()*1000))
    by_key = {s['key']:s for s in sources}
    size = sum(len(s['quote']) for s in evidence)
    for row in nearby:
        source = by_key[row['key']]
        if source['id'] in used or len(evidence)>=32 or size+len(source['quote'])>24000: continue
        evidence.append(source); used.add(source['id']); size+=len(source['quote'])
    payload = {'mode':'voice_summary_verify','question':question,'sources':evidence,'proposed_reply':{'claims':facts}}
    try: verified, count = gather([job('verify', payload, partial(complete,payload))], deadline, current)
    except Exception as exc:
        if isinstance(exc,HTTPException) and exc.status_code==409: raise
        return voice_failure('verification_unavailable')
    if verified is None: return pending(question,count,1)
    raw = verified[0]
    result = validate_voice_answer(raw,evidence)
    body = json.loads(raw)
    if not result['claims'] and not result.get('clarification'):
        return voice_failure(body.get('reason') if body.get('reason') in ('verification_rejected','verification_unavailable') else 'insufficient_evidence')
    text = result.get('clarification') or ' '.join(c['text'] for c in result['claims'])
    if result.get('follow_up'): text += ' ' + result['follow_up']
    if not result.get('clarification'):
        text = ('Up to the time you asked: ' if re.search(r'\b(?:summary|summari[sz]e|recap)\b',question.casefold()) else 'Tóm tắt đến lúc bạn hỏi: ') + text
    return {'text':text,'sources':result['sources'],'answer_kind':'meeting',
            'reason':'clarification' if result.get('clarification') else 'answered',
            'clarification':bool(result.get('clarification')),'verification':body.get('verification',[])}
