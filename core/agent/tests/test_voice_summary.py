"""Whole-meeting recaps wait for background stages and never publish partial coverage."""
import json
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest
from fastapi import HTTPException

from control_plane import voice_summary as summary
from shared.voice_summary import wants_summary


def test_stop_ends_the_wait_before_a_running_provider_finishes_and_never_schedules_selection():
    entered,release,finished=threading.Event(),threading.Event(),threading.Event()
    current=[True];modes=[];scope='cancel-wait-test'
    def permit():
        if not current[0]:raise HTTPException(409,'Stopped')
    def complete(payload):
        modes.append(payload['mode']);entered.set();assert release.wait(3)
        return '{"claims":[]}'
    source={'key':'a','kind':'transcript','quote':'Backend dùng PostgreSQL.'}
    with ThreadPoolExecutor(max_workers=1) as caller:
        result=caller.submit(summary.recap,'Tổng hợp quyết định cuộc họp.',[source],scope,complete,current=permit)
        try:
            assert entered.wait(2);current[0]=False
            with pytest.raises(HTTPException) as error:result.result(timeout=1)
            assert error.value.status_code==409 and modes==['voice_summary_map']
        finally:
            with summary._lock:
                jobs=[job for key,(_,job) in summary._cache.items() if key[0]==scope]
            for job in jobs:job.add_done_callback(lambda _:finished.set())
            release.set();assert finished.wait(2)


def test_refined_scope_reaches_map_selection_and_verification_as_one_question():
    question='Tổng hợp quyết định cuộc họp.\nYêu cầu cập nhật: Chỉ lấy phần backend thôi.'
    source={'key':'a','kind':'transcript','quote':'Backend dùng PostgreSQL.'};payloads=[]
    def complete(payload):
        payloads.append(payload)
        assert payload['question']==question
        return '{"claims":[{"text":"Backend dùng PostgreSQL.","source_ids":["s0"]}],"verification":["approved"]}'
    result=summary.recap(question,[source],'refined-scope-test',complete)
    assert wants_summary(question) and result['reason']=='answered'
    assert [p['mode'] for p in payloads]==['voice_summary_map','voice_summary_select','voice_summary_verify']


@pytest.mark.parametrize('question', ['Tổng hợp toàn bộ quyết định trong cuộc họp.',
    'Tóm tắt cuộc họp', 'Summarize the entire meeting', 'Tổng hợp các công việc trong cuộc họp'])
def test_full_recap_intents_include_decisions_and_tasks(question):
    assert wants_summary(question)


@pytest.mark.parametrize('question', ['Cách tóm tắt cuộc họp?', 'Tóm tắt 5 phút vừa rồi', 'Ai phụ trách demo?',
    'Tổng hợp quyết định đã duyệt trong cuộc họp', 'Summarize saved decisions in this meeting'])
def test_local_questions_do_not_trigger_whole_meeting_work(question):
    assert not wants_summary(question)


def test_recap_waits_for_background_map_select_and_verification_without_a_repeat(monkeypatch):
    source = {'id': 's0', 'key': 'segment:a', 'fingerprint': 'a' * 64,
              'kind': 'transcript', 'quote': 'Lan làm demo.', 'start_ms': 1, 'end_ms': 2}
    entered, release = threading.Event(), threading.Event()
    modes = []
    def complete(payload):
        modes.append(payload['mode'])
        if payload['mode'] == 'voice_summary_map':
            entered.set()
            assert release.wait(3)
        return '{"claims":[{"text":"Lan làm demo.","source_ids":["s0"]}],"verification":["approved"]}'
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(summary.recap, 'Tóm tắt cuộc họp', [source], 'auto-complete-test', complete, budget=3)
        assert entered.wait(2)
        assert not future.done(), 'Pending work must not ask the caller to repeat.'
        release.set()
        result = future.result(timeout=3)
    assert result['reason'] == 'answered' and result['sources'][0]['key'] == source['key']
    assert modes == ['voice_summary_map', 'voice_summary_select', 'voice_summary_verify']


def test_every_stage_shares_one_waiting_deadline_instead_of_returning_after_map_window(monkeypatch):
    deadlines = []
    monkeypatch.setattr(summary.time, 'monotonic', lambda: 0)
    claim = {'text': 'Lan làm demo.', 'source_ids': ['s0']}
    def gather(jobs, deadline, current=None):
        deadlines.append(deadline)
        stage = jobs[0][0][1]
        return ([json.dumps({'claims': [claim]})] if stage == 'verify' else [[claim]]), 1
    monkeypatch.setattr(summary, 'gather', gather)
    row = {'id': 's0', 'key': 'a', 'kind': 'transcript', 'quote': 'Lan làm demo.'}
    assert summary.recap('Tóm tắt cuộc họp', [row], 'deadline-test', lambda _: None)['reason'] == 'answered'
    assert deadlines == [120, 120, 120]


def test_timeout_never_publishes_partial_facts_or_promises_automatic_later_playback(monkeypatch):
    monkeypatch.setattr(summary, 'gather', lambda *_: (None, 1))
    row = {'key': 'a', 'kind': 'transcript', 'quote': 'Lan làm demo.'}
    result = summary.recap('Tóm tắt cuộc họp', [row], 'timeout-test', lambda _: None, budget=.01)
    assert result['reason'] == 'summary_pending' and result['sources'] == []
    assert 'hỏi lại' not in result['text'] and 'chưa hoàn tất' in result['text']


def test_busy_background_pool_waits_for_a_slot_then_finishes_without_another_request():
    acquired = 0
    try:
        for _ in range(3):
            assert summary._slots.acquire(blocking=False)
            acquired += 1
        with ThreadPoolExecutor(max_workers=1) as caller:
            future = caller.submit(summary.gather, [(('busy-pool-test',), lambda: 'finished')],
                                   summary.time.monotonic() + 3)
            summary.time.sleep(.1)
            assert not future.done()
            for _ in range(acquired): summary._slots.release()
            acquired = 0
            assert future.result(timeout=3) == (['finished'], 1)
    finally:
        for _ in range(acquired): summary._slots.release()
