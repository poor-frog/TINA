"""Vietnamese search views never alter evidence or widen the authorized candidate set."""
import json

import pytest

from shared.voice_lexical import DEFAULT_DOMAIN, vietnamese_terms, alias_view, domain_dictionary, lexical_rankings, weighted_rrf, character_scores
from shared.voice_tools import normalize_tool_call, parse_search_query
from shared.voice_knowledge import voice_sources, lookup_voice_sources
from shared.voice_evidence import evidence_pack


def source(key, quote, **metadata):
    return {'key': key, 'fingerprint': key, 'kind': 'transcript', 'quote': quote,
            'meeting_id': 1, 'speaker_id': 's1', 'revision': 2, 'start_ms': 1000, 'end_ms': 2000} | metadata


def test_underthesea_and_raw_channels_keep_original_evidence():
    assert 'hệ_thống' in vietnamese_terms('hệ thống')
    rows = [source('a', 'Lan phụ trách hệ thống PostgreSQL-16.'), source('b', 'Chuyện khác.')]
    copy = json.loads(json.dumps(rows))
    found, _ = voice_sources(rows, 'Hệ thống PostgreSQL-16 do ai phụ trách?', [], 0)
    assert found and found[0]['key'] == 'a' and found[0]['quote'] == rows[0]['quote']
    assert found[0]['retrieval']['vietnamese_tokenizer'] is True
    assert rows == copy and found[0]['fingerprint'] == 'a'


def test_weighted_rrf_assigns_equal_semantic_and_total_lexical_budget():
    scores = weighted_rrf({'raw': [0], 'vietnamese': [0], 'alias': [0], 'character': [0], 'semantic': [1]})
    assert scores[0] == pytest.approx(scores[1])


def test_domain_dictionary_is_workspace_local_and_cannot_change_numbers_negation_or_paths(tmp_path, caplog):
    a, b = tmp_path/'a', tmp_path/'b'; a.mkdir(); b.mkdir()
    config = a/'retrieval-domain.json'
    config.write_text(json.dumps({'version': 1, 'aliases': {'aster': ['át tơ']}}))
    assert alias_view('Dự án át tơ', domain_dictionary(a)) == 'dự án aster'
    assert alias_view('Dự án át tơ', domain_dictionary(b)) == 'dự án át tơ'
    for aliases in [{'100': ['200']}, {'đã chốt': ['chưa chốt']}, {'gpt6': ['gpt7']}]:
        config.write_text(json.dumps({'version': 1, 'aliases': aliases}))
        assert domain_dictionary(a) == DEFAULT_DOMAIN
    config.unlink(); config.symlink_to(b/'config.json'); (b/'config.json').write_text('{}')
    assert domain_dictionary(a) == DEFAULT_DOMAIN
    assert 'using built-in aliases' in caplog.text and str(tmp_path) not in caplog.text


@pytest.mark.parametrize('content', ['{PRIVATE', 'x' * 32769,
    pytest.param('[' * 15000 + '0' + ']' * 15000, id='deep-json'),
    '{"version":1,"aliases":{"aster":["át tơ"],"gpt6":["gpt7"]}}'])
def test_bad_dictionary_falls_back_atomically_without_logging_content(tmp_path, caplog, content):
    (tmp_path/'retrieval-domain.json').write_text(content)
    assert domain_dictionary(tmp_path) == DEFAULT_DOMAIN
    assert 'PRIVATE' not in caplog.text and 'aster' not in caplog.text and str(tmp_path) not in caplog.text


def test_unreadable_dictionary_does_not_disable_retrieval(tmp_path, monkeypatch):
    from pathlib import Path
    (tmp_path/'retrieval-domain.json').write_text('{}')
    def denied(*args, **kwargs): raise PermissionError('PRIVATE PATH')
    monkeypatch.setattr(Path, 'read_text', denied)
    assert domain_dictionary(tmp_path) == DEFAULT_DOMAIN


def test_aliases_and_ngrams_only_offer_candidates_not_corrected_quotes():
    rows = [source('a', 'Đề mô sẽ chạy trên PostgreSQL.'), source('b', 'Ngân sách 200.')]
    selected, _ = voice_sources(rows, 'demo postgres', [], 0)
    assert selected[0]['key'] == 'a' and selected[0]['quote'].startswith('Đề mô')
    assert character_scores('100 200 không', ['300 400 có']) == [0]
    rankings, _, _ = lexical_rankings('postgresqll', rows)
    assert rankings['character'] == [0]


def test_filters_narrow_before_ranking_and_context_expansion_entity_is_only_a_hint():
    rows = [source('a', 'Lan làm demo Aster.'), source('b', 'Minh làm demo.', speaker_id='s2'),
            source('c', 'Lan bàn deadline.', start_ms=50000, end_ms=51000)]
    call = normalize_tool_call({'name': 'search_meeting', 'arguments': {'query': 'demo', 'filters': {
        'speaker_id': 's1', 'start_ms': 0, 'end_ms': 3000, 'entities': ['Không tồn tại']}}})
    seed, _ = voice_sources(rows, 'demo deadline', [], 0)
    assert {s['key'] for s in seed} == {'a', 'b', 'c'}
    selected, _ = lookup_voice_sources(rows, seed, [call], 0)
    assert [s['key'] for s in selected] == ['a']
    assert all(s['speaker_id'] == 's1' and s['end_ms'] <= 3000 for s in selected)
    filters = {'speaker_id': None, 'start_ms': None, 'end_ms': None, 'entities': []}
    for invalid in [filters | {'start_ms': True}, filters | {'start_ms': 10, 'end_ms': 1}, filters | {'owner_id': 999}]:
        with pytest.raises(ValueError): normalize_tool_call({'name': 'search_meeting', 'arguments': {'query': 'demo', 'filters': invalid}})
    with pytest.raises(ValueError): parse_search_query(json.dumps({'query': 'demo', 'filters': {'meeting_id': 999}}))


def test_scoped_lookup_union_preserves_comparisons_but_not_unfiltered_seed():
    rows = [source('a', 'Lan làm demo.'), source('b', 'Minh làm demo.', speaker_id='s2'),
            source('c', 'Khác làm demo.', speaker_id='s3')]
    seed, _ = voice_sources(rows, 'demo', [], 0)
    def call(speaker):
        return normalize_tool_call({'name': 'search_meeting', 'arguments': {'query': 'demo', 'filters': {
            'speaker_id': speaker, 'start_ms': None, 'end_ms': None, 'entities': []}}})
    found, _ = lookup_voice_sources(rows, seed, [call('s1'), call('s2')], 0)
    assert {s['key'] for s in found} == {'a', 'b'}
    assert not lookup_voice_sources(rows, seed, [call('unknown')], 0)[0]
    hints = call(None)
    assert {s['key'] for s in lookup_voice_sources(rows, seed, [hints], 0)[0]} == {'a', 'b', 'c'}


def test_time_only_lookup_also_replaces_unfiltered_seed():
    rows = [source('a', 'Demo early.'), source('b', 'Demo later.', start_ms=50000, end_ms=51000)]
    seed, _ = voice_sources(rows, 'demo', [], 0)
    call = normalize_tool_call({'name':'search_meeting','arguments':{'query':'demo','filters':{
        'speaker_id':None,'start_ms':None,'end_ms':3000,'entities':[]}}})
    assert [s['key'] for s in lookup_voice_sources(rows, seed, [call], 0)[0]] == ['a']


def test_zero_clock_disables_recent_context_in_search_and_offline_evaluation():
    rows = [source('missing', 'Unrelated cooking.', end_ms=None),
            source('zero', 'Unrelated cooking.', start_ms=0, end_ms=0),
            source('early', 'Unrelated cooking.', start_ms=0, end_ms=500)]
    assert voice_sources(rows, 'PostgreSQL deadline', [], 0) == ([], [])
    found, trace = lookup_voice_sources(rows, [], [{'name':'search_meeting','query':'PostgreSQL deadline'}], 1000)
    assert not found and trace == [{'tool':'search_meeting','source_count':0}]


def test_recent_context_requires_known_finite_timestamp_but_search_can_use_undated_evidence():
    rows = [source(str(i), 'Unrelated cooking.', end_ms=end)
            for i, end in enumerate([None, True, float('nan'), float('inf'), float('-inf')])]
    rows += [source('valid', 'Unrelated cooking.', start_ms=0, end_ms=500)]
    found, recent = voice_sources(rows, 'PostgreSQL deadline', [], 1000)
    assert [s['key'] for s in found] == ['valid'] and recent == [found[0]['id']]
    matched, _ = voice_sources([source('undated', 'PostgreSQL deadline.', end_ms=None)], 'PostgreSQL', [], 0)
    assert [s['key'] for s in matched] == ['undated']


def test_sentence_window_keeps_two_neighbors_but_never_crosses_meeting_or_time():
    rows = [source('a', 'Lan phụ trách demo.'), source('b', 'Chúng ta chuyển sang chủ đề khác.'),
            source('c', 'Hạn là thứ Sáu.'), source('d', 'PRIVATE OTHER MEETING', meeting_id=2),
            source('e', 'PRIVATE FAR TIME', start_ms=100000, end_ms=101000)]
    found, _ = voice_sources(rows, 'demo', [], 0, retrieval_version='v2')
    assert {'a', 'b', 'c'} == {s['key'] for s in found}
    assert next(s for s in found if s['key'] == 'c')['retrieval']['context_only'] is True
    pack = evidence_pack(found, available=len(rows))
    assert pack['version'] == 'retrieval-evidence.v2' and pack['bounded'] is True
    assert {s['key'] for s in pack['items']} == {'a', 'b', 'c'}
    assert 'PRIVATE' not in json.dumps(pack)
    assert all(s['fingerprint'] == s['key'] and s['revision'] == 2 for s in pack['items'])
