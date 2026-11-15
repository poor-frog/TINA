"""Optional reranking cannot invent evidence, lose heard context or weaken final review."""
import json
from types import SimpleNamespace

import pytest

from shared.voice_rerank import rerank_voice_sources, RERANK_SYSTEM
from shared.meeting_knowledge import PREFIX
from shared.voice_knowledge import VERIFY_SYSTEM


def sources():
    return [{'id': f's{i}', 'key': f'key-{i}', 'quote': f'Synthetic excerpt {i}.',
             'fingerprint': str(i) * 64} for i in range(20)]


def test_rerank_keeps_original_objects_stable_ids_recent_speech_and_heard_context():
    rows = sources()
    history = [{'question': 'Demo?', 'answer': 'Lan.', 'source_ids': ['s3']}]
    def complete(raw):
        assert json.loads(raw)['history'] == history
        return '{"source_ids":["s8","s2"]}'
    selected, outcome = rerank_voice_sources('Deadline?', rows, history, ['s19'], complete)
    assert outcome == 'applied'
    assert [s['id'] for s in selected] == ['s8', 's2', 's3', 's19']
    assert selected[0] is rows[8] and len(rows) == 20


@pytest.mark.parametrize('raw', ['not JSON', '{"source_ids":["s999"]}',
    '{"source_ids":["s1","s1"]}', '{"source_ids":[{}]}',
    '{"source_ids":["s1"],"claims":["invented"]}'])
def test_invalid_ranking_keeps_complete_original_retrieval(raw):
    rows = sources()
    selected, outcome = rerank_voice_sources('Q?', rows, [], [], lambda _: raw)
    assert outcome == 'fallback' and selected is rows


@pytest.mark.parametrize('pinned', [False, True])
def test_valid_empty_rank_is_not_a_failure_and_only_retains_explicit_heard_context(pinned):
    rows = sources();original = json.loads(json.dumps(rows));calls = []
    def complete(prompt):calls.append(prompt);return '{"source_ids":[]}'
    history = [{'source_ids':['s3']}] if pinned else []
    selected,outcome = rerank_voice_sources('Unrelated?',rows,history,['s19'] if pinned else [],complete)
    assert outcome == 'empty' and len(calls) == 1
    assert [s['id'] for s in selected] == (['s3','s19'] if pinned else [])
    assert rows == original
    if pinned: assert selected[0] is rows[3]


def test_empty_rank_does_not_seed_irrelevant_sources_from_each_meeting():
    rows = [s|{'meeting_id':1 if i<10 else 2} for i,s in enumerate(sources())]
    assert rerank_voice_sources('Unrelated?',rows,[],[],lambda _:'{"source_ids":[]}') == ([], 'empty')
    selected,outcome = rerank_voice_sources('Follow-up?',rows,[{'source_ids':['s12']}],[],lambda _:'{"source_ids":[]}')
    assert outcome == 'empty' and selected == [rows[12]]


@pytest.mark.parametrize('invalid_first', [False, True])
def test_empty_worker_generation_and_format_repair_cannot_restore_discarded_sources(monkeypatch,caplog,invalid_first):
    from worker import engine
    from shared.voice_knowledge import VOICE_FORMAT_SYSTEM
    rows = sources();events=[];seen=[]
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-empty-rank')
    def complete(prompt,*,system):
        body=json.loads(prompt);seen.append((system,body))
        if system == RERANK_SYSTEM:return SimpleNamespace(text='{"source_ids":[]}')
        assert system != VERIFY_SYSTEM
        assert body['sources'] == []
        if system != VOICE_FORMAT_SYSTEM:
            assert not body['evidence_pack']['items'] and body['evidence_pack']['selected']==0
            if invalid_first:return SimpleNamespace(text='{"claims":[{"text":"Must not restore old evidence.","source_ids":["s0"]}]}')
        return SimpleNamespace(text='{"claims":[]}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    payload={'mode':'voice','question':'PRIVATE UNRELATED QUESTION','sources':rows,'tools_remaining':0}
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps({
        'request_id':'empty-rank','text':json.dumps(payload)})}})
    result=json.loads(next(event['text'] for event in events if event['type']=='message-delta'))
    assert result['claims']==[] and result['reason']=='retrieval_empty'
    records=[json.loads(r.message) for r in caplog.records if r.name=='shared.voice_trace']
    assert any(r.get('outcome')=='empty' and r.get('output_sources')==0 for r in records)
    assert 'PRIVATE' not in caplog.text
    assert sum(system==VOICE_FORMAT_SYSTEM for system,_ in seen)==int(invalid_first)


def test_empty_rank_with_pinned_sources_keeps_full_contradiction_review_but_repair_cannot_reseed(monkeypatch):
    from worker import engine
    from shared.voice_knowledge import VOICE_REPAIR_SYSTEM
    rows=sources();rows[19]['quote']='Lan owns demo.';rows[0]['quote']='Correction: Minh owns demo.'
    events=[];seen=[]
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-empty-pinned')
    def complete(prompt,*,system):
        body=json.loads(prompt);seen.append(system)
        if system==RERANK_SYSTEM:return SimpleNamespace(text='{"source_ids":[]}')
        if system==VERIFY_SYSTEM:
            assert body['sources']==rows
            return SimpleNamespace(text='{"approved":false,"reason":"contradiction"}')
        assert [s['id'] for s in body['sources']]==['s19']
        if system==VOICE_REPAIR_SYSTEM:
            return SimpleNamespace(text='{"claims":[{"text":"Minh owns demo.","source_ids":["s0"]}]}')
        return SimpleNamespace(text='{"claims":[{"text":"Lan owns demo.","source_ids":["s19"]}]}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    payload={'mode':'voice','question':'Owner?','sources':rows,'recent_source_ids':['s19'],'tools_remaining':0}
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps({
        'request_id':'empty-pinned','text':json.dumps(payload)})}})
    result=json.loads(next(event['text'] for event in events if event['type']=='message-delta'))
    assert not result['claims'] and result['verification']==['contradiction','repair_failed']
    assert seen.count(VERIFY_SYSTEM)==seen.count(VOICE_REPAIR_SYSTEM)==1


@pytest.mark.parametrize('tools_remaining', [0,1])
def test_empty_rank_retains_bounded_lookup_or_real_verifier_failure_status(monkeypatch,tools_remaining):
    from worker import engine
    events=[];rows=sources()
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-empty-status')
    def complete(prompt,*,system):
        if system==RERANK_SYSTEM:return SimpleNamespace(text='{"source_ids":[]}')
        if system==VERIFY_SYSTEM:raise TimeoutError('PRIVATE temporary verifier failure')
        assert json.loads(prompt)['sources']==[]
        return SimpleNamespace(text='{"tool_calls":[{"name":"search_meeting","query":"demo"}]}' if tools_remaining
            else '{"claims":[],"clarification":"Bạn đang hỏi phần nào?"}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps({
        'request_id':'empty-status','text':json.dumps({'mode':'voice','question':'Question?','sources':rows,'tools_remaining':tools_remaining})})}})
    result=json.loads(next(event['text'] for event in events if event['type']=='message-delta'))
    if tools_remaining:assert result['tool_calls']==[{'name':'search_meeting','query':'demo'}]
    else:assert result['reason']=='verification_unavailable' and result['verification']==['unavailable']


def test_timeout_and_excess_protected_context_keep_original_and_small_inputs_skip_llm():
    rows = sources()
    def fail(_): raise TimeoutError('private provider message')
    assert rerank_voice_sources('Q?', rows, [], [], fail) == (rows, 'fallback')
    assert rerank_voice_sources('Q?', rows[:2], [], [], fail) == (rows[:2], 'skipped')
    long = [s | {'quote': 'x' * 1200} for s in rows + [
        {'id': f'extra{i}', 'key': f'extra{i}'} for i in range(13)]]
    selected, outcome = rerank_voice_sources('Q?', long, [], [s['id'] for s in long], lambda _: '{"source_ids":["s0"]}')
    assert selected is long and outcome == 'fallback'


def test_worker_generates_from_ranked_sources_but_verifies_against_all_original_evidence(monkeypatch):
    from worker import engine
    from shared.voice_knowledge import VOICE_REPAIR_SYSTEM
    rows = sources()
    rows[8]['quote'] = 'Lan owns demo.'
    rows[19]['quote'] = 'Correction: Minh owns demo.'
    events, seen = [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-rerank-test')
    def complete(prompt, *, system):
        body = json.loads(prompt); seen.append((system, body))
        if system == RERANK_SYSTEM: return SimpleNamespace(text='{"source_ids":["s8"]}')
        if system == VERIFY_SYSTEM:
            assert body['sources'] == rows
            return SimpleNamespace(text='{"approved":false,"reason":"contradiction"}')
        if system == VOICE_REPAIR_SYSTEM: return SimpleNamespace(text='{"claims":[]}')
        assert [s['id'] for s in body['sources']] == ['s8']
        return SimpleNamespace(text='{"claims":[{"text":"Lan owns demo.","source_ids":["s8"]}]}')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete=complete))
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    source = {'mode': 'voice', 'question': 'Who owns demo?', 'sources': rows}
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': 'rerank-test', 'text': json.dumps(source)})}})
    result = json.loads(events[0]['text'])
    assert not result['claims'] and result['verification'] == ['contradiction']
    assert sum(system == RERANK_SYSTEM for system, _ in seen) == 1
