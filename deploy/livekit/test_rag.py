import asyncio
import json
import logging
from uuid import uuid4

import pytest
from langsmith.utils import tracing_is_enabled

from rag import run_rag, PARALLEL_READS, TOOLS, SourceAccessChanged, RetrievalUnavailable


async def test_second_search_targets_missing_deadline_and_preserves_verified_result(monkeypatch):
    monkeypatch.setenv('LANGSMITH_TRACING', 'true')
    operations, known = [], []
    result = {'text': 'Lan phụ trách demo, hạn thứ Sáu.', 'sources': [{'id': 's0'}, {'id': 's1'}],
              'lookups': ['owner', 'deadline'], 'verification': {'approved': True}}
    request = {'body': {'question': 'Ai làm demo và hạn khi nào?'}, 'speaker': 'caller'}
    async def agent(actual, operation, lookup=None):
        assert actual is request and not tracing_is_enabled()
        operations.append((operation, lookup))
        if operation == 'plan':
            return {'tool_calls': [{'name': 'search_meeting', 'query': 'demo phụ trách' if not known else 'demo hạn bàn giao'}]}
        known.append('Lan' if not known else 'thứ Sáu')
        return {'source_count': 1}
    async def answer(actual):
        assert actual is request and known == ['Lan', 'thứ Sáu']
        operations.append(('answer', None))
        return result
    assert await run_rag(request, agent, answer, lambda: True) == result
    assert operations == [('plan', None), ('lookup', {'name': 'search_meeting', 'query': 'demo phụ trách'}),
                          ('plan', None), ('lookup', {'name': 'search_meeting', 'query': 'demo hạn bàn giao'}),
                          ('answer', None)]


@pytest.mark.parametrize('rounds', [0, 1, 2])
async def test_equivalent_tool_budget_and_early_exit(rounds):
    plans, lookups, answers = [], [], []
    async def agent(request, operation, lookup=None):
        if operation == 'lookup': lookups.append(lookup); return {'source_count': 1}
        plans.append(operation)
        return {'tool_calls': [{'name': 'search_meeting', 'query': f'query {len(plans)}:{i}'} for i in range(2)]
                if len(plans) <= rounds else []}
    async def answer(request): answers.append(request); return {'text': 'Verified answer.'}
    await run_rag({}, agent, answer, lambda: True)
    assert len(plans) == min(rounds + 1, 2) and len(lookups) == rounds * 2
    assert len(answers) == 1


@pytest.mark.parametrize('calls', [None, {}, [{'name': 'approve_task', 'query': 'demo'}],
    [{'name': 'search_web', 'query': ''}], [{'name': 'search_meeting', 'query': 'x' * 201}],
    [{'name': 'search_meeting', 'query': 'demo', 'path': '/private'}],
    [{'name': 'get_recent_transcript', 'query': ''}] * 2,
    [{'name': 'search_meeting', 'query': str(i)} for i in range(3)]])
async def test_invalid_plan_never_executes_tools_or_dispatches_answer(calls):
    operations = []
    async def agent(request, operation, lookup=None):
        operations.append(operation); return {'tool_calls': calls}
    async def answer(request): pytest.fail('Invalid tool plan must not answer')
    with pytest.raises(ValueError): await run_rag({}, agent, answer, lambda: True)
    assert operations == ['plan']


async def test_identical_second_lookup_is_rejected_before_execution():
    operations = []
    async def agent(request, operation, lookup=None):
        operations.append(operation)
        return {'tool_calls': [{'name': 'search_meeting', 'query': 'demo'}]} if operation == 'plan' else {'source_count': 1}
    async def answer(request): pytest.fail('Repeated tool call must not answer')
    with pytest.raises(ValueError): await run_rag({}, agent, answer, lambda: True)
    assert operations == ['plan', 'lookup', 'plan']


@pytest.mark.parametrize('blocked', ['plan', 'lookup', 'answer'])
async def test_stop_cancels_current_node_without_later_dispatch(blocked):
    entered, closed = asyncio.Event(), asyncio.Event()
    operations = []
    async def call(operation):
        operations.append(operation)
        if operation == blocked:
            entered.set()
            try: await asyncio.Event().wait()
            finally: closed.set()
    async def agent(request, operation, lookup=None):
        await call(operation)
        return {'tool_calls': [{'name': 'search_meeting', 'query': str(len(operations))}]} if operation == 'plan' else {'source_count': 1}
    async def answer(request): await call('answer'); return {'text': 'Never played'}
    task = asyncio.create_task(run_rag({}, agent, answer, lambda: True))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert closed.is_set() and operations[-1] == blocked


@pytest.mark.parametrize('stage', ['plan', 'lookup', 'answer'])
async def test_late_node_cannot_publish_after_request_changes(stage):
    current = True
    planned = False
    async def agent(request, operation, lookup=None):
        nonlocal current, planned
        if operation == stage: current = False
        if operation == 'plan':
            calls = [] if planned else [{'name': 'search_meeting', 'query': 'demo'}]
            planned = True
            return {'tool_calls': calls}
        return {'source_count': 1}
    async def answer(request):
        nonlocal current
        assert stage == 'answer'
        current = False
        return {'text': 'Late answer'}
    with pytest.raises(RuntimeError, match='turn changed'):
        await run_rag({}, agent, answer, lambda: current)


async def test_tool_failure_never_falls_through_to_an_unverified_answer():
    operations = []
    async def agent(request, operation, lookup=None):
        operations.append(operation)
        if operation == 'lookup': raise RuntimeError('Policy revoked')
        return {'tool_calls': [{'name': 'search_shared_documents', 'query': 'demo'}]}
    async def answer(request): pytest.fail('Lookup rejection must not answer')
    with pytest.raises(RuntimeError, match='Policy revoked'):
        await run_rag({}, agent, answer, lambda: True)
    assert operations == ['plan', 'lookup']


async def test_concurrent_graphs_keep_meeting_caller_and_result_isolated():
    async def agent(request, operation, lookup=None):
        await asyncio.sleep(0)
        if operation == 'plan': return {'tool_calls': []}
        pytest.fail('No tool was planned')
    async def answer(request): return {'text': request['speaker'], 'sources': [request['body']]}
    requests = [{'body': {'meeting_id': i}, 'speaker': f'caller-{i}'} for i in range(3)]
    results = await asyncio.gather(*(run_rag(r, agent, answer, lambda: True) for r in requests))
    assert results == [{'text': r['speaker'], 'sources': [r['body']]} for r in requests]


async def test_no_tool_backend_and_clarification_preserve_original_response():
    async def answer(request): return {'text': 'Bạn muốn phần backend hay demo?', 'clarification': True}
    assert await run_rag({}, None, answer, lambda: True) == await answer({})


async def test_graph_timings_join_the_request_uuid_without_private_content(caplog):
    identifier = str(uuid4()); planned = False
    async def agent(request, operation, lookup=None):
        nonlocal planned
        if operation == 'plan':
            calls = [] if planned else [{'name': 'search_meeting', 'query': 'PRIVATE QUERY'}]
            planned = True
            return {'tool_calls': calls}
        return {'source_count': 2, 'sources': [{'quote': 'PRIVATE EVIDENCE'}]}
    async def answer(request): return {'text': 'PRIVATE ANSWER'}
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        await run_rag({'body': {'request_id': identifier}, 'token': 'SECRET'}, agent, answer, lambda: True)
    rows = [json.loads(r.message) for r in caplog.records if r.name == 'shared.voice_trace']
    assert {r['request_id'] for r in rows} == {identifier}
    assert [r['stage'] for r in rows] == ['rag_plan', 'rag_lookup:search_meeting', 'rag_lookup_batch', 'rag_assess', 'rag_plan', 'rag_answer', 'rag_total']
    assert [r['round'] for r in rows if r['stage'] == 'rag_plan'] == [1, 2]
    assert rows[1]['output_sources'] == 2
    assert all(r['elapsed_ms'] >= 0 for r in rows)
    assert 'PRIVATE' not in caplog.text and 'SECRET' not in caplog.text


async def test_typed_plan_is_normalized_before_lookup_without_changing_wire_shape():
    planned = False; lookups = []
    async def agent(request, operation, lookup=None):
        nonlocal planned
        if operation == 'plan':
            calls = [] if planned else [
                {'name': 'search_meeting', 'arguments': {'query': 'chi phí'}},
                {'name': 'calculate', 'arguments': {'expression': '100+200', 'context_handles': []}}]
            planned = True
            return {'tool_calls': calls}
        lookups.append(lookup); return {'source_count': 1}
    async def answer(request): return {'text': 'Kết quả đã kiểm chứng.'}
    await run_rag({}, agent, answer, lambda: True)
    assert lookups == [{'name': 'search_meeting', 'query': 'chi phí'},
                       {'name': 'calculate', 'query': '{"expression":"100+200"}'}]


async def test_typed_and_legacy_same_call_share_the_duplicate_fence():
    plans = 0; lookups = []
    async def agent(request, operation, lookup=None):
        nonlocal plans
        if operation == 'plan':
            plans += 1
            return {'tool_calls': [{'name': 'search_meeting', 'arguments': {'query': 'demo'}}
                                   if plans == 1 else {'name': 'search_meeting', 'query': 'demo'}]}
        lookups.append(lookup); return {'source_count': 1}
    async def answer(request): pytest.fail('Repeated lookup must not answer')
    with pytest.raises(ValueError): await run_rag({}, agent, answer, lambda: True)
    assert len(lookups) == 1


async def test_independent_searches_overlap_and_next_plan_waits_for_both(caplog):
    arrived, release = asyncio.Event(), asyncio.Event()
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]
    started, completed, plans = [], [], []
    async def agent(request, operation, lookup=None):
        if operation == 'plan':
            plans.append(operation)
            if len(plans) == 1: return {'tool_calls': calls}
            assert set(completed) == {c['name'] for c in calls}
            return {'tool_calls': []}
        started.append(lookup['name'])
        if len(started) == 2: arrived.set()
        await release.wait()
        completed.append(lookup['name']); return {'source_count': 1}
    async def answer(request):
        assert len(completed) == 2
        return {'text': 'Đã đối chiếu hai nguồn.'}
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        task = asyncio.create_task(run_rag({}, agent, answer, lambda: True))
        try:
            await asyncio.wait_for(arrived.wait(), 2)
            assert len(plans) == 1 and not task.done()
        finally: release.set()
        await task
    batch = [json.loads(r.message) for r in caplog.records if r.name == 'shared.voice_trace'
             and json.loads(r.message)['stage'] == 'rag_lookup_batch']
    assert len(batch) == 1 and batch[0]['parallel'] is True and batch[0]['tool_count'] == 2
    assert PARALLEL_READS < TOOLS


@pytest.mark.parametrize('mode', ['stop', 'failure', 'stale'])
async def test_parallel_batch_cancels_and_drains_siblings_without_answer(mode):
    arrived, release, finished = asyncio.Event(), asyncio.Event(), set()
    started = []
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]
    current = True
    async def agent(request, operation, lookup=None):
        if operation == 'plan': return {'tool_calls': calls}
        name = lookup['name']; started.append(name)
        if len(started) == 2: arrived.set()
        try:
            if name == 'search_meeting' and mode != 'stop':
                await release.wait()
                if mode == 'failure': raise RuntimeError('PRIVATE backend rejection')
                return {'source_count': 1}
            await asyncio.Event().wait()
        finally: finished.add(name)
    async def answer(request): pytest.fail('Failed/stopped batch must never answer')
    task = asyncio.create_task(run_rag({}, agent, answer, lambda: current))
    try:
        await asyncio.wait_for(arrived.wait(), 2)
        if mode == 'stop': task.cancel()
        else:
            if mode == 'stale': current = False
            release.set()
        if mode == 'stop':
            with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(task, 2)
        else:
            with pytest.raises(RuntimeError, match='parallel lookup failed'): await asyncio.wait_for(task, 2)
        assert finished == {c['name'] for c in calls}
    finally:
        if not task.done(): task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('name,query', [('calculate', '{"expression":"100+200"}'),
    ('draft_task', 'demo'), ('draft_decision', 'demo'), ('read_source_context', 'ctx-'+'a'*64),
    ('open_source', 'ctx-'+'a'*64), ('search_web', 'explicit public query')])
async def test_non_independent_batch_stays_sequential(name, query):
    started, plans = [], 0; entered, release = asyncio.Event(), asyncio.Event()
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': name, 'query': query}]
    async def agent(request, operation, lookup=None):
        nonlocal plans
        if operation == 'plan':
            plans += 1; return {'tool_calls': calls if plans == 1 else []}
        started.append(lookup['name'])
        if len(started) == 1: entered.set(); await release.wait()
        return {'source_count': 1}
    async def answer(request): return {'text': 'Verified result'}
    task = asyncio.create_task(run_rag({}, agent, answer, lambda: True))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        await asyncio.sleep(0)
        assert started == ['search_meeting']
    finally: release.set()
    await task
    assert started == [c['name'] for c in calls]


@pytest.mark.parametrize('slow_failure', [True, False])
async def test_temporary_source_failure_keeps_other_source_then_goes_straight_to_verified_answer(caplog, slow_failure):
    both = asyncio.Event(); started = []; done = []; plans = []
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]
    async def agent(request, operation, lookup=None):
        if operation == 'plan': plans.append(operation); return {'tool_calls': calls}
        name = lookup['name']; started.append(name)
        if len(started) == 2: both.set()
        await both.wait()
        if (name == 'search_meeting') == slow_failure: await asyncio.sleep(.01)
        done.append(name)
        return {'source_count': 0, 'sources': [], 'lookup_status': 'unavailable', 'retrieval_unavailable': True,
                'skipped': True} if name == 'search_meeting' else {'source_count': 1, 'lookup_status': 'found'}
    result = {'text': 'Phần đã xác minh từ Wiki.', 'sources': [{'id': 's1'}], 'verification': ['approved']}
    async def answer(request):
        assert len(done) == 2 and len(plans) == 1
        return result
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        assert await run_rag({}, agent, answer, lambda: True) == result
    records = [json.loads(r.message) for r in caplog.records if r.name == 'shared.voice_trace']
    assert any(r['stage'] == 'rag_assess' and r['lookup_outcome'] == 'partial' for r in records)


@pytest.mark.parametrize('kind', ['empty', 'unavailable', 'budget'])
async def test_empty_and_unavailable_take_different_branches(kind):
    plans = 0; lookup_count = 0
    async def agent(request, operation, lookup=None):
        nonlocal plans, lookup_count
        if operation == 'plan':
            plans += 1; return {'tool_calls': [{'name': 'search_meeting', 'query': f'demo {plans}'}]}
        lookup_count += 1
        return {'source_count': 0, 'sources': [], **({'retrieval_unavailable': True} if kind == 'unavailable'
            else {'budget_exhausted': True} if kind == 'budget' else {'lookup_status': 'empty'})}
    async def answer(request):
        assert kind == 'empty' and plans == lookup_count == 2
        return {'text': 'Em chưa đủ bằng chứng.', 'reason': 'insufficient_evidence'}
    if kind == 'empty':
        assert (await run_rag({}, agent, answer, lambda: True))['reason'] == 'insufficient_evidence'
    else:
        with pytest.raises(RetrievalUnavailable): await run_rag({}, agent, answer, lambda: True)
        assert plans == lookup_count == 1


async def test_second_round_outage_can_use_successful_first_round_evidence():
    plans = 0
    async def agent(request, operation, lookup=None):
        nonlocal plans
        if operation == 'plan':
            plans += 1; return {'tool_calls': [{'name': 'search_meeting', 'query': f'part {plans}'}]}
        return {'source_count': 1} if plans == 1 else {'source_count': 0, 'skipped': True, 'retrieval_unavailable': True}
    async def answer(request): return {'text': 'Đã xác minh phần đầu.', 'sources': [{'id': 's0'}]}
    assert (await run_rag({}, agent, answer, lambda: True))['sources'] == [{'id': 's0'}]


async def test_revoked_source_is_fatal_even_with_successful_sibling():
    success = asyncio.Event()
    async def agent(request, operation, lookup=None):
        if operation == 'plan': return {'tool_calls': [
            {'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]}
        if lookup['name'] == 'search_meeting': success.set(); return {'source_count': 1}
        await success.wait(); raise SourceAccessChanged('Source revoked')
    async def answer(request): pytest.fail('Revocation must block final answer')
    with pytest.raises(SourceAccessChanged, match='parallel lookup failed'):
        await run_rag({}, agent, answer, lambda: True)


@pytest.mark.parametrize('result', [None, {}, {'source_count': True}, {'source_count': -1},
    {'source_count': 1, 'lookup_status': 'unavailable'}, {'source_count': 0, 'skipped': 'yes'}])
async def test_malformed_lookup_response_is_not_an_empty_or_transient_result(result):
    async def agent(request, operation, lookup=None):
        return {'tool_calls': [{'name': 'search_meeting', 'query': 'demo'}]} if operation == 'plan' else result
    async def answer(request): pytest.fail('Malformed data cannot answer')
    with pytest.raises(ValueError): await run_rag({}, agent, answer, lambda: True)
