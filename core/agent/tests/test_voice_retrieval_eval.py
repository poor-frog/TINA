"""Private snapshot labels are pinned to literal evidence; retrieval is not answer accuracy."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

MODULE = Path(__file__).parents[1] / 'eval/voice/retrieval.py'
spec = importlib.util.spec_from_file_location('voice_retrieval_eval', MODULE)
evaluation = importlib.util.module_from_spec(spec); spec.loader.exec_module(evaluation)


def fixture(tmp_path):
    canonical = {'segments': [{'segment_id': 'a', 'revision': 1, 'text': 'Lan phụ trách demo.',
                              'start_ms': 1000, 'end_ms': 2000},
                             {'segment_id': 'b', 'revision': 1, 'text': 'Hạn demo là thứ Sáu.',
                              'start_ms': 3000, 'end_ms': 4000}]}
    snapshot = tmp_path / 'snapshot.json'
    snapshot.write_text(json.dumps({'meetings': [{'meeting_id': 1, 'owner_id': 7, 'canonical': canonical}]}))
    case = {'id': '1', 'meeting_ids': [1], 'question': 'Ai phụ trách demo và hạn khi nào?',
            'expected': 'answerable', 'review_status': 'draft', 'reference_answer': 'Lan; thứ Sáu.',
            'evidence': [{'meeting_id': 1, 'segment_id': s['segment_id'], 'revision': 1, 'quote': s['text']}
                         for s in canonical['segments']]}
    gold = {'snapshot_sha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(), 'cases': [case]}
    dataset = tmp_path / 'cases.json'; dataset.write_text(json.dumps(gold))
    return snapshot, dataset, gold


def test_evaluation_requires_all_labelled_quotes_and_preserves_draft_status(tmp_path):
    snapshot, dataset, gold = fixture(tmp_path)
    by_id, loaded = evaluation.load_cases(snapshot, dataset)
    result = evaluation.evaluate(by_id, loaded)
    assert result['cases'][0]['gold_evidence_recall'] == 1
    assert result['summary']['all_evidence_found_cases'] == 1
    assert result['summary']['approved_cases'] == 0 and 'correctness' not in result['summary']
    gold['cases'][0].update(id='negative', expected='unanswerable', evidence=[])
    dataset.write_text(json.dumps(gold))
    by_id, loaded = evaluation.load_cases(snapshot, dataset)
    row = evaluation.evaluate(by_id, loaded)['cases'][0]
    assert row['gold_evidence_recall'] is None and row['all_evidence_found'] is None


@pytest.mark.parametrize('change', ['hash', 'quote', 'revision', 'scope', 'duplicate', 'owner'])
def test_changed_or_unscoped_gold_is_rejected(tmp_path, change):
    snapshot, dataset, gold = fixture(tmp_path)
    if change == 'hash': gold['snapshot_sha256'] = '0' * 64
    if change == 'quote': gold['cases'][0]['evidence'][0]['quote'] = 'Invented fact'
    if change == 'revision': gold['cases'][0]['evidence'][0]['revision'] = 2
    if change == 'scope': gold['cases'][0]['meeting_ids'] = [2]
    if change == 'duplicate': gold['cases'] *= 2
    if change == 'owner':
        data = json.loads(snapshot.read_text()); data['meetings'].append({'meeting_id': 2, 'owner_id': 8, 'canonical': {}})
        snapshot.write_text(json.dumps(data)); gold['snapshot_sha256'] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    dataset.write_text(json.dumps(gold))
    with pytest.raises(ValueError): evaluation.load_cases(snapshot, dataset)


@pytest.mark.parametrize('reason',['llm_unavailable','generation_format_invalid'])
def test_answer_grades_require_approved_labels_and_service_failures_are_not_false_refusals(tmp_path,reason):
    _, _, gold = fixture(tmp_path)
    gold['cases'] += [gold['cases'][0] | {'id': '2'}, gold['cases'][0] | {'id': '3', 'expected': 'unanswerable'}]
    answers = {'cases': [{'id': '1', 'reason': 'insufficient_evidence', 'text': 'PRIVATE ANSWER', 'human_correct': False},
                         {'id': '2', 'reason': reason}, {'id': '3', 'reason': 'answered'}]}
    report = evaluation.answer_report(gold, answers)
    assert report['answerable_refusals'] == 1 and report['service_errors'] == 1
    assert report['negative_answers_needing_review'] == 1 and report['human_correct_rate'] is None
    assert 'PRIVATE' not in json.dumps(report)
    gold['cases'][0]['review_status'] = 'approved'
    assert evaluation.answer_report(gold, answers)['human_correct_rate'] == 0
    assert evaluation.answer_report(gold, {})['not_run'] == 3
    with pytest.raises(ValueError): evaluation.answer_report(gold, {'cases': answers['cases'] * 2})


def test_rank_metrics_respect_k_and_grade_unique_source_segments_once(tmp_path):
    snapshot, dataset, gold = fixture(tmp_path)
    gold['cases'][0]['evidence'][0]['relevance'] = 3
    gold['cases'][0]['evidence'][1]['relevance'] = 1
    dataset.write_text(json.dumps(gold))
    by_id, labels = evaluation.load_cases(snapshot, dataset)
    result = evaluation.evaluate(by_id, labels, k=1)
    row = result['cases'][0]
    assert row['recall_at_k'] == .5 and 0 <= row['ndcg_at_k'] <= 1
    assert result['summary']['retrieval_p95_ms'] >= 0
    assert result['retrieval_version'] == 'v2'
    assert evaluation.evaluate(by_id, labels, version='v1', k=2)['cases'][0]['recall_at_k'] == 1
    with pytest.raises(ValueError): evaluation.evaluate(by_id, labels, k=0)
    with pytest.raises(ValueError): evaluation.evaluate(by_id, labels, k=13)
    with pytest.raises(ValueError): evaluation.evaluate(by_id, labels, result_limit=True)


def test_reranker_full_recall_uses_same_depth_and_reports_candidate_coverage(tmp_path, monkeypatch):
    snapshot, dataset, _ = fixture(tmp_path)
    by_id, labels = evaluation.load_cases(snapshot, dataset)
    rows = [{'key':str(i), 'meeting_id':1, 'segment_id':str(i), 'quote':'Other'} for i in range(19)]
    rows += [{'key':'gold', 'meeting_id':1, 'segment_id':'a', 'quote':'Lan phụ trách demo.'}]
    labels['cases'][0]['evidence'] = labels['cases'][0]['evidence'][:1]
    monkeypatch.setattr(evaluation, 'voice_sources', lambda *args, **kwargs: (rows, []))
    reports = [evaluation.evaluate(by_id, labels, rerank=ranker) for ranker in
               (None, lambda q, sources: sources, lambda q, sources: sources[:12])]
    for report in reports:
        result = report['cases'][0]
        assert report['result_limit'] == result['retrieved_count'] == 12
        assert result['gold_evidence_recall'] == result['recall_at_k'] == 0
        assert result['pre_rerank_count'] == 20 and result['pre_rerank_evidence_recall'] == 1
    assert evaluation.evaluate(by_id, labels, result_limit=20)['cases'][0]['gold_evidence_recall'] == 1


def test_ndcg_does_not_credit_the_wrong_slice_of_a_long_labelled_segment():
    canonical = {'segments': [{'segment_id': 'long', 'revision': 1,
        'text': 'Introduction. ' * 200 + 'Final fact: Lan owns demo.', 'start_ms': 0, 'end_ms': 2000}]}
    gold = {'snapshot_sha256': 'synthetic', 'cases': [{'id': '1', 'meeting_ids': [1],
        'question': 'Introduction', 'expected': 'answerable', 'review_status': 'draft',
        'evidence': [{'meeting_id': 1, 'segment_id': 'long', 'quote': 'Final fact: Lan owns demo.'}]}]}
    result = evaluation.evaluate({1: canonical}, gold, k=1, rerank=lambda question, rows: rows[:1])
    assert result['cases'][0]['recall_at_k'] == result['cases'][0]['ndcg_at_k'] == 0


@pytest.mark.parametrize('outcome', ['applied', 'fallback', 'empty'])
def test_explicit_llm_reranker_evaluation_records_applied_or_fallback_without_network(tmp_path, monkeypatch, outcome):
    import sys
    from types import SimpleNamespace
    import llm
    snapshot, dataset, gold = fixture(tmp_path)
    body = json.loads(snapshot.read_text())
    body['meetings'][0]['canonical']['segments'] += [
        {'segment_id': f'extra-{i}', 'revision': 1, 'text': f'Demo discussion {i}.',
         'start_ms': 5000+i*1000, 'end_ms': 5500+i*1000} for i in range(12)]
    snapshot.write_text(json.dumps(body)); gold['snapshot_sha256'] = hashlib.sha256(snapshot.read_bytes()).hexdigest()
    dataset.write_text(json.dumps(gold)); calls = []
    def structured(prompt, **kwargs):
        calls.append(kwargs)
        if outcome=='fallback': raise llm.LLMError('Synthetic provider unavailable')
        sources = json.loads(prompt)['sources']
        return SimpleNamespace(text=json.dumps({'source_ids': [] if outcome=='empty' else [s['id'] for s in sources[:2]]}))
    monkeypatch.setattr(llm, 'completion_from_env', lambda **kwargs: SimpleNamespace(complete_structured=structured))
    output = tmp_path/'result.json'
    monkeypatch.setattr(sys, 'argv', ['retrieval.py', '--snapshot', str(snapshot), '--dataset', str(dataset),
        '--output', str(output), '--llm-rerank'])
    evaluation.main(); report = json.loads(output.read_text())
    assert len(calls) == 1 and 'schema' in calls[0]
    assert report['reranker']['outcomes'][outcome] == 1
    assert sum(report['reranker']['outcomes'].values()) == 1
    if outcome=='empty':assert report['cases'][0]['retrieved_count']==0


def test_web_numeric_mismatch_is_a_refusal_and_empty_generation_is_a_service_failure(tmp_path):
    _,_,gold=fixture(tmp_path)
    first=evaluation.answer_report(gold,{'cases':[{'id':'1','reason':'web_numeric_mismatch'}]})
    second=evaluation.answer_report(gold,{'cases':[{'id':'1','reason':'web_answer_empty'}]})
    assert first['answerable_refusals']==1 and first['service_errors']==0
    assert second['service_errors']==1 and second['answerable_refusals']==0
