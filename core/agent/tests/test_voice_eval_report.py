"""Evidence and timing checks for the local conversational evaluation harness."""
import importlib.util
import json
from pathlib import Path

import pytest

MODULE = Path(__file__).parents[1] / 'eval/voice/report.py'
spec = importlib.util.spec_from_file_location('voice_eval_report', MODULE)
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def test_runtime_report_distinguishes_pass_failure_error_and_skip(tmp_path):
    path = tmp_path / 'bot.xml'
    path.write_text('<testsuites><testsuite><testcase name="pass"/><testcase name="failed"><failure/></testcase>'
                    '<testcase name="error"><error/></testcase><testcase name="skipped"><skipped/></testcase>'
                    '</testsuite></testsuites>')
    assert report.runtime_results(path) == {'pass': 'passed', 'failed': 'failed', 'error': 'failed', 'skipped': 'not_run'}
    path.write_text('<testsuite><testcase name="same"/><testcase name="same"/></testsuite>')
    with pytest.raises(ValueError, match='Duplicate'):
        report.runtime_results(path)


def test_latency_deduplicates_turns_separates_notices_and_does_not_copy_private_log_text(tmp_path):
    path = tmp_path / 'bot.log'
    def event(key, durations, **kw):
        return '[bot] ' + json.dumps({'type': 'voice_timing', 'request_id': key, 'durations_ms': durations,
                                     'private_text': 'PRIVATE MEETING CONTENT', **kw})
    path.write_text('\n'.join([
        'unrelated private text', 'invalid {json',
        event('a', {'notice_after_question': 900}),
        event('a', {'notice_after_question': 900, 'answer_playback_after_end': 2400}),
        event('a', {'answer_playback_after_end': 2400}, stage='turn_finished', outcome='completed'),
        event('b', {'ack_after_question': 100, 'answer_playback_after_end': 3000}, stage='turn_finished', outcome='interrupted'),
        event('c', {'answer_playback_after_end': 4000, 'answer_service': -2, 'asr_request': True},
              stage='turn_finished', outcome='clarification'),
    ]))
    value = report.latency_report(path)
    assert value['observed_turns'] == 3 and value['completed_turns'] == 2
    assert value['completed']['answer_playback_after_end'] == {'n': 2, 'p50_ms': 3200, 'p95_ms': 4000}
    assert value['all_observed']['notice_after_question'] == {'n': 1, 'p50_ms': 900, 'p95_ms': 900}
    assert 'ack_after_question' not in value['completed']
    assert 'answer_service' not in value['completed'] and 'asr_request' not in value['completed']
    assert 'PRIVATE' not in json.dumps(value) and 'request_id' not in json.dumps(value)


def test_notice_only_logs_do_not_imply_any_answer_latency(tmp_path):
    path = tmp_path / 'bot.log'
    path.write_text(json.dumps({'type': 'voice_timing', 'request_id': 'a',
                                'durations_ms': {'ack_after_question': 100}}))
    value = report.latency_report(path)
    assert value['completed'] == {} and 'answer_playback_after_end' not in value['all_observed']


def test_stage_report_deduplicates_spans_keeps_rounds_and_omits_content(tmp_path):
    from uuid import uuid4
    path = tmp_path / 'stages.log'; identifier = str(uuid4())
    event = {'type': 'voice_stage', 'request_id': identifier, 'span_id': str(uuid4()),
             'stage': 'rag_plan', 'round': 1, 'elapsed_ms': 100, 'status': 'ok', 'query': 'PRIVATE QUERY'}
    rows = [event, event, event | {'span_id': str(uuid4()), 'round': 2, 'elapsed_ms': 300, 'status': 'cancelled'},
            event | {'span_id': str(uuid4()), 'stage': 'PRIVATE STAGE'},
            event | {'request_id': 'SECRET'}, event | {'span_id': str(uuid4()), 'elapsed_ms': True}]
    path.write_text('\n'.join(json.dumps(r) for r in rows))
    result = report.stage_report(path)
    assert result['observed_turns'] == 1
    assert result['stages']['rag_plan'] == {'n': 2, 'p50_ms': 200, 'p95_ms': 300, 'errors': 0, 'cancelled': 1}
    assert [r['round'] for r in result['turns'][identifier]] == [1, 2]
    assert 'PRIVATE' not in json.dumps(result) and 'SECRET' not in json.dumps(result)


def test_parallel_lookup_report_uses_wall_batch_time_instead_of_summing_tool_times(tmp_path):
    from uuid import uuid4
    path = tmp_path / 'parallel.log'; identifier = str(uuid4())
    spans = [{'stage': 'rag_lookup:search_meeting', 'elapsed_ms': 100},
             {'stage': 'rag_lookup:search_shared_documents', 'elapsed_ms': 150},
             {'stage': 'rag_lookup_batch', 'elapsed_ms': 160, 'parallel': True, 'tool_count': 2},
             {'stage': 'rag_assess', 'elapsed_ms': 0, 'lookup_outcome': 'partial'}]
    path.write_text('\n'.join(json.dumps({'type': 'voice_stage', 'request_id': identifier,
        'span_id': str(uuid4()), 'status': 'ok'} | row) for row in spans))
    value = report.stage_report(path)
    assert value['turns'][identifier][-2]['parallel'] is True
    assert value['turns'][identifier][-1]['lookup_outcome'] == 'partial'
    text = '\n'.join(report.stage_markdown(value))
    assert '| '+identifier+' | — | 160 |' in text
    assert '| '+identifier+' | — | 250 |' not in text


def test_stage_report_separates_empty_success_and_rerank_fallback(tmp_path):
    from uuid import uuid4
    identifier=str(uuid4());path=tmp_path/'rank.log'
    path.write_text('\n'.join(json.dumps({'type':'voice_stage','request_id':identifier,'span_id':str(uuid4()),
        'stage':'source_selection','elapsed_ms':1,'status':'ok','outcome':outcome,'question':'PRIVATE'})
        for outcome in ['applied','empty','fallback','skipped','PRIVATE OUTCOME']))
    value=report.stage_report(path)
    assert [r.get('outcome') for r in value['turns'][identifier]]==['applied','empty','fallback','skipped',None]
    assert value['stages']['source_selection']['outcomes']=={'applied':1,'empty':1,'fallback':1,'skipped':1}
    assert 'empty=1' in '\n'.join(report.stage_markdown(value))
    assert 'PRIVATE' not in json.dumps(value)


def test_ab_comparison_rejects_incomparable_inputs_and_never_names_a_naturalness_winner():
    before = {'fixture': 'same', 'live_llm': True, 'label': 'baseline',
              'cases': [{'id': 1, 'question': 'Ai?', 'text': 'Lan.', 'status': 'live_smoke_passed', 'elapsed_ms': 100}]}
    after = before | {'label': 'candidate', 'cases': [before['cases'][0] | {'text': 'Phần demo đã giao cho Lan.'}]}
    comparison = report.compare_reports(after, before)
    assert comparison['pairs'][0]['before_text'] == 'Lan.'
    assert 'winner' not in comparison and comparison['pairs'][0]['after_answer_service_ms'] == 100
    for invalid in [before | {'fixture': 'different'}, before | {'live_llm': False}, before | {'cases': []},
                    before | {'completion_config': {'provider': 'different', 'model': 'different'}},
                    before | {'cases': [before['cases'][0] | {'question': 'Ai khác?'}]}]:
        with pytest.raises(ValueError):
            report.compare_reports(after, invalid)


def test_suite_has_twenty_unique_cases_and_only_existing_runtime_tests():
    suite = json.loads(MODULE.with_name('conversations.json').read_text())
    cases = suite['cases']
    assert len(cases) == 20 and {row['id'] for row in cases} == set(range(1, 21))
    runtime_source = (MODULE.parents[3] / 'meetings/services/bot/src/meeting-voice.test.ts').read_text()
    segments = {row['segment_id'] for row in suite['segments']}
    for case in cases:
        if case['layer'] == 'runtime':
            assert f"test('{case['runtime_test']}'" in runtime_source
        else:
            assert case['mode'] == 'meeting' and case['question'].strip()
            for turn in case['history']:
                assert set(turn['segment_ids']) <= segments


def test_markdown_reports_unmeasured_audio_honestly_and_escapes_model_text(tmp_path):
    target = tmp_path / 'report.md'
    value = {'label': 'local', 'live_llm': False, 'cases': [
        {'id': 1, 'title': 'Owner | deadline', 'status': 'routing_passed', 'evaluated_layer': 'routing-only'}]}
    report.write_markdown(value, target)
    text = target.read_text()
    assert 'Owner \\| deadline' in text and 'Not measured' in text and 'No audio was generated' in text


@pytest.mark.parametrize('unavailable', [False, True])
def test_live_runner_uses_real_synthetic_sources_without_mac_tmp_symlink_mismatch(tmp_path, monkeypatch, unavailable):
    import sys
    from control_plane import meeting_knowledge
    monkeypatch.syspath_prepend(str(MODULE.parent))
    run_spec = importlib.util.spec_from_file_location('voice_eval_runner', MODULE.with_name('run.py'))
    runner = importlib.util.module_from_spec(run_spec)
    run_spec.loader.exec_module(runner)
    monkeypatch.setattr(meeting_knowledge, 'meeting_get', meeting_knowledge.meeting_get)
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'before-test')
    monkeypatch.setenv('TINA_CHAT_SESSION', 'before-test')
    def worker(stream, topic, request):
        from shared.meeting_knowledge import PREFIX
        body = json.loads(request['entrypoint']['inline'][len(PREFIX):])
        query = json.loads(body['text'])
        assert query['mode'] == 'voice' and query['sources']
        source = next(row for row in query['sources'] if 'Lan phụ trách' in row['quote'])
        result = {'claims': [], 'reason': 'llm_unavailable'} if unavailable else {
            'claims': [{'text': 'Phần demo đã giao cho Lan.', 'source_ids': [source['id']]}]}
        stream.xadd(topic, {'event': json.dumps({'type': 'message-delta', 'text': json.dumps(result)})})
    monkeypatch.setattr(runner, '_run_meeting_knowledge', worker)
    output = tmp_path / 'live.json'
    monkeypatch.setattr(sys, 'argv', ['run.py', '--suite', 'conversations', '--live', '--cases', '3', '--output', str(output)])
    if unavailable:
        with pytest.raises(SystemExit) as exc:
            runner.main()
        assert exc.value.code == 1
    else:
        runner.main()
    value = json.loads(output.read_text())
    assert value['cases'][0]['http_status'] == 200 and output.with_suffix('.md').is_file()
    assert value['cases'][0]['has_evidence'] is not unavailable
    assert value['cases'][0]['passed'] is not unavailable
    assert all(rating is None for rating in value['cases'][0]['human_ratings'].values())


def test_prompt_override_covers_generation_repair_and_format_recovery(tmp_path, monkeypatch):
    import sys
    from control_plane import meeting_knowledge
    from shared import voice_knowledge
    monkeypatch.syspath_prepend(str(MODULE.parent))
    run_spec = importlib.util.spec_from_file_location('voice_eval_baseline', MODULE.with_name('run.py'))
    runner = importlib.util.module_from_spec(run_spec)
    run_spec.loader.exec_module(runner)
    monkeypatch.setattr(meeting_knowledge, 'meeting_get', meeting_knowledge.meeting_get)
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'before-test')
    monkeypatch.setenv('TINA_CHAT_SESSION', 'before-test')
    for key in ('VOICE_SYSTEM', 'VOICE_REPAIR_SYSTEM', 'VOICE_FORMAT_SYSTEM'):
        monkeypatch.setattr(voice_knowledge, key, getattr(voice_knowledge, key))
    baseline = tmp_path / 'prompt.txt'
    baseline.write_text('Synthetic baseline prompt.')
    monkeypatch.setattr(sys, 'argv', ['run.py', '--cases', '1', '--prompt-file', str(baseline),
                                    '--output', str(tmp_path / 'baseline.json')])
    runner.main()
    assert voice_knowledge.VOICE_SYSTEM == baseline.read_text()
    assert voice_knowledge.VOICE_REPAIR_SYSTEM.startswith(baseline.read_text())
    assert voice_knowledge.VOICE_FORMAT_SYSTEM.startswith(baseline.read_text())
