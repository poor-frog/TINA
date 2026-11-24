import json

import pytest

from shared.meeting_knowledge import sources_for
from shared.voice_knowledge import voice_sources, current_history, validate_voice_answer, pending_clarification

NOW = 1800000000000


def test_rejected_detail_can_leave_a_separately_verified_supported_claim():
    from shared.voice_knowledge import verify_voice_reply
    sources=[{'id':'s0','quote':'Lan phụ trách demo.'}]
    raw=json.dumps({'claims':[{'text':'Lan phụ trách demo.','source_ids':['s0']},
                             {'text':'Hạn thứ Sáu.','source_ids':['s0']}],
                    'follow_up':'Bạn có thể xác nhận hạn bàn giao không?'})
    reviewed=[]
    def review(prompt):
        reply=json.loads(prompt)['reply'];reviewed.append(reply)
        return json.dumps({'approved':False,'reason':'unsupported_claim','claim_indexes':[1]}) if len(reply['claims'])==2 else '{"approved":true}'
    result=json.loads(verify_voice_reply(raw,'Ai phụ trách demo và hạn khi nào?',sources,review,diagnostics=True))
    assert result['claims']==[{'text':'Lan phụ trách demo.','source_ids':['s0']}]
    assert result['follow_up']=='Bạn có thể xác nhận hạn bàn giao không?' and len(reviewed)==2
    plain=json.loads(verify_voice_reply(raw,'Ai và hạn?',sources,review))
    assert plain=={k:v for k,v in result.items() if k!='verification'}
    repaired=json.loads(verify_voice_reply(raw,'Ai và hạn?',sources,review,repair=lambda _: 'invalid JSON',diagnostics=True))
    assert repaired['claims']==result['claims'] and repaired['verification']==['unsupported_claim','approved']
    unavailable=json.loads(verify_voice_reply(raw,'Ai và hạn?',sources,lambda _: (_ for _ in ()).throw(RuntimeError()),diagnostics=True))
    assert not unavailable['claims'] and unavailable['reason']=='verification_unavailable'


def test_semantic_social_fallback_accepts_only_bounded_intents_and_skips_compound_requests():
    from shared.voice_knowledge import semantic_assistant_intent
    calls=[]
    def classify(question):
        calls.append(question)
        return json.dumps({'intent':'thanks'})
    assert semantic_assistant_intent('Cảm ơn TINA nha, được rồi.',classify)=='thanks'
    for question in ('Cảm ơn, deadline của chúng ta là gì?', 'Chào TINA và ai phụ trách demo?',
                     'Gửi email cảm ơn nhóm', 'TINA ơi', 'Ngân sách?', 'chào ' * 100):
        assert semantic_assistant_intent(question,classify) is None
    assert len(calls)==1
    for raw in ('bad json', '[]', '{"intent":"web"}', '{"intent":"thanks","answer":"invented"}'):
        assert semantic_assistant_intent('Cảm ơn TINA nha.',lambda _:raw) is None


def test_dialogue_note_keeps_chained_topic_and_latest_correction_without_answer_facts():
    from shared.voice_knowledge import dialogue_context
    rows=sources_for({'segments':[segment('demo','Demo giao Lan, hạn thứ Sáu.',NOW-1000)]},{})
    refs=[{k:rows[0][k] for k in ('key','fingerprint')}]
    history=[{'question':q,'answer':'ANSWER IS NOT EVIDENCE','created_at_ms':NOW-1000,'sources':refs}
             for q in ('Ai phụ trách demo?', 'Còn hạn?', 'Sprint trước cơ.')]
    valid=current_history(history,rows,NOW)
    note=dialogue_context('Còn ngày bàn giao?',valid,NOW)
    assert note=={'goal':'Ai phụ trách demo?','refinements':['Còn hạn?','Sprint trước cơ.']}
    assert 'ANSWER' not in json.dumps(note)
    queries=[]
    voice_sources(rows,'Còn ngày bàn giao?',valid,NOW,semantic=lambda q,_:queries.append(q) or [])
    assert all(q in queries[0] for q in ('demo','Sprint trước cơ.','Còn ngày bàn giao?'))
    assert dialogue_context('ASR là gì?',valid,NOW) is None
    assert dialogue_context('Còn hạn?',valid,NOW+120001) is None
    assert dialogue_context('Còn hạn?',current_history(history,[],NOW),NOW) is None


def test_clarification_retry_count_stops_at_a_real_answer_and_never_counts_service_errors():
    from shared.voice_recovery import clarification_attempts
    assert clarification_attempts([])==0
    assert clarification_attempts([{'clarification':True}]*5)==3
    assert clarification_attempts([{'clarification':True},{'clarification':False}])==0
    assert clarification_attempts([{'reason':'llm_unavailable'},{'clarification':True}])==1


def test_missing_evidence_does_not_masquerade_as_a_question_about_an_ambiguous_request():
    from shared.voice_knowledge import voice_failure
    for reason in ('insufficient_evidence', 'verification_rejected', 'verification_unavailable', 'llm_unavailable'):
        result = voice_failure(reason)
        assert result['reason'] == reason and result['sources'] == [] and result['answer_kind'] == 'meeting'
        assert '?' not in result['text']
    assert voice_failure('retrieval_empty')['text'].endswith('?')


def test_voice_verifier_rejects_a_sourced_fact_that_only_identifies_the_subject():
    from shared.voice_knowledge import verify_voice_reply

    source = {'id': 's0', 'quote': 'Bảo phụ trách kiểm thử.'}
    candidate = {'claims': [{'text': source['quote'], 'source_ids': ['s0']}]}

    def review(prompt):
        turn = json.loads(prompt)
        assert turn['reply'] == candidate
        approved = turn['question'].startswith('Ai phụ trách')
        return json.dumps({'approved': True} if approved else
                          {'approved': False, 'reason': 'unsupported_claim', 'claim_indexes': [0]})

    alone = json.loads(verify_voice_reply(json.dumps(candidate), 'Số điện thoại của người phụ trách là gì?',
                                        [source], review, repair=lambda _: '{"claims":[]}', diagnostics=True))
    partial = json.loads(verify_voice_reply(json.dumps(candidate), 'Ai phụ trách và số điện thoại là gì?',
                                          [source], review, diagnostics=True))
    assert alone['claims'] == []
    assert partial['claims'] == candidate['claims'] and partial['verification'] == ['approved']


def test_pending_clarification_keeps_original_goal_and_corrections_but_expires():
    first = {'question': 'Tóm tắt phần đó.', 'answer': 'Bạn muốn tóm tắt chủ đề nào?',
             'clarification': True, 'created_at_ms': NOW - 2000, 'sources': []}
    second = first | {'question': 'Backend.', 'answer': 'Backend của dự án nào?', 'created_at_ms': NOW - 1000}
    history = current_history([first, second], [], NOW)
    assert pending_clarification(history, NOW) == {
        'question': first['question'], 'asked': second['answer'], 'replies': ['Backend.']}
    assert pending_clarification(current_history([first | {'created_at_ms': NOW - 35000}, second], [], NOW), NOW)['question'] == first['question']
    assert not current_history([first], [], NOW + 30001)
    assert pending_clarification(history, NOW + 30001) is None
    assert pending_clarification(history + [second | {'clarification': False}], NOW) is None
    changed = second | {'sources': [{'key': 'removed', 'fingerprint': 'a' * 64}]}
    assert not current_history([changed], [], NOW)
    assert pending_clarification(current_history([first, changed], [], NOW), NOW) is None
    sources = sources_for({'segments': [segment('goal', 'Tóm tắt backend của dự án A.', NOW - 500000)]}, {})
    queries = []
    voice_sources(sources, 'Không, dự án A.', history, NOW, semantic=lambda q, _: queries.append(q) or [])
    assert first['question'] in queries[0] and 'Backend.' in queries[0] and 'Không, dự án A.' in queries[0]


def segment(identifier, text, end):
    return dict(segment_id=identifier, revision=0, text=text, start_ms=end - 1000, end_ms=end)


def test_voice_retrieval_reserves_recent_context_and_ranks_latest_relevant_evidence():
    rows = [segment(str(i), 'Chuyện khác không liên quan.', NOW - 500000 + i * 1000) for i in range(50)]
    rows += [segment('old', 'Deadline demo là thứ Sáu.', NOW - 200000),
             segment('new', 'Deadline demo đổi sang thứ Hai.', NOW - 20000),
             segment('neighbor', 'Lan phụ trách kiểm thử.', NOW - 19000)]
    sources = sources_for({'segments': rows}, {})
    selected, recent = voice_sources(sources, 'Deadline demo?', [], NOW)
    keys = [s['key'] for s in selected]
    assert keys.index('segment:new') < keys.index('segment:old')
    assert 'segment:neighbor' in keys
    assert {s['key'] for s in selected if s['id'] in recent} == {'segment:new', 'segment:neighbor'}
    assert len(selected) <= 32 and sum(len(s['quote']) for s in selected) <= 24000
    assert not any(s['quote'] == 'Chuyện khác không liên quan.' for s in selected)


def test_followup_uses_only_fresh_authorized_history_and_keeps_it_out_of_evidence():
    sources = sources_for({'segments': [segment('demo', 'Minh làm bản demo.', NOW - 300000)]}, {})
    refs = [{k: sources[0][k] for k in ('key', 'fingerprint')}]
    turn = {'question': 'Ai làm demo?', 'answer': 'Minh.', 'created_at_ms': NOW - 10000, 'sources': refs}
    history = current_history([turn], sources, NOW)
    selected, _ = voice_sources(sources, 'Vậy khi nào xong?', history, NOW)
    assert selected[0]['key'] == 'segment:demo'
    assert all(s['kind'] == 'transcript' and s['quote'] != turn['answer'] for s in selected)
    assert not current_history([turn], [], NOW)
    assert not current_history([turn | {'created_at_ms': NOW - 900001}], sources, NOW)
    changed = sources_for({'segments': [segment('demo', 'Lan làm demo.', NOW - 300000)]}, {})
    assert not current_history([turn], changed, NOW)
    assert not voice_sources(sources, 'Giá cà phê hôm nay?', [], NOW)[0]


def test_voice_output_allows_bounded_clarification_without_inventing_fact_citations():
    raw = json.dumps({'claims': [], 'clarification': 'Bạn hỏi bản demo hay bản chính thức?'})
    assert validate_voice_answer(raw, [])['clarification'].endswith('?')
    for body in [{'claims': [], 'clarification': 'Chắc chắn thứ Sáu.'},
                 {'claims': [], 'clarification': 'x' * 201 + '?'},
                 {'claims': [{'text': 'x', 'source_ids': ['invented']}]}]:
        with pytest.raises(ValueError): validate_voice_answer(json.dumps(body), [])
    sources = [{'id': 's0'}]
    for claims in [[{'text': 'x', 'source_ids': ['s0']}] * 4,
                   [{'text': 'x' * 801, 'source_ids': ['s0']}]]:
        with pytest.raises(ValueError): validate_voice_answer(json.dumps({'claims': claims}), sources)


def test_short_clarification_answer_retains_its_authorized_topic_without_turning_history_into_evidence():
    sources=sources_for({'segments':[segment('demo','Bản demo giao thứ Hai.',NOW-500000),
                                    segment('production','Bản production giao thứ Sáu.',NOW-490000)]},{})
    turn={'question':'Hạn bản nào?', 'answer':'Bạn hỏi demo hay production?', 'clarification':True,
          'created_at_ms':NOW-10000,'sources':[{k:s[k] for k in ('key','fingerprint')} for s in sources]}
    history=current_history([turn],sources,NOW)
    selected,_=voice_sources(sources,'Chính thức.',history,NOW)
    assert {s['key'] for s in selected}=={s['key'] for s in sources}
    assert all(s['quote'] not in [turn['question'],turn['answer']] for s in selected)
    assert not voice_sources(sources,'Chính thức.',[turn|{'created_at_ms':NOW-30001}],NOW)[0]
    assert not current_history([turn],[],NOW)


def test_verifier_preserves_approved_text_and_rejects_wrong_numbers_or_uncertain_provider():
    from shared.voice_knowledge import verify_voice_reply
    sources = [{'id': 's0', 'quote': 'Lan phụ trách demo, hạn 12/04/2026, chi phí 100 USD.'}]
    raw = json.dumps({'claims': [{'text': 'Lan phụ trách demo, hạn 12/04/2026.', 'source_ids': ['s0']}]})
    calls = []
    def review(prompt): calls.append(json.loads(prompt)); return '{"approved":true}'
    assert verify_voice_reply(raw, 'Ai làm demo?', sources, review) == raw
    assert calls[0]['sources'] == sources
    bad = raw.replace('12/04/2026', '13/04/2026')
    assert json.loads(verify_voice_reply(bad, 'Hạn nào?', sources, review)) == {'claims': []}
    assert len(calls) == 1
    for verdict in ['{"approved":false}', '{"approved":"true"}', 'invalid JSON']:
        assert json.loads(verify_voice_reply(raw, 'Hạn nào?', sources, lambda _: verdict)) == {'claims': []}
    def unavailable(_): raise TimeoutError('private provider output')
    assert json.loads(verify_voice_reply(raw, 'Hạn nào?', sources, unavailable)) == {'claims': []}
    clarification = json.dumps({'claims': [], 'clarification': 'Bạn hỏi demo hay bản chính thức?'})
    assert verify_voice_reply(clarification, 'Hạn nào?', sources, review) == clarification


def test_semantic_rejection_catches_wrong_owner_or_proposal_without_rewriting_the_reply():
    from shared.voice_knowledge import verify_voice_reply
    source = [{'id': 's0', 'quote': 'Lan đề xuất hạn thứ Sáu. Minh chưa chốt.'}]
    for text in ['Minh phụ trách.', 'Deadline đã chốt thứ Sáu.']:
        raw = json.dumps({'claims': [{'text': text, 'source_ids': ['s0']}]})
        assert json.loads(verify_voice_reply(raw, 'Ai phụ trách?', source, lambda _: '{"approved":false}')) == {'claims': []}


def test_bounded_tools_search_full_authorized_snapshot_without_opening_model_paths():
    from shared.voice_knowledge import voice_tool_calls, lookup_voice_sources
    sources = sources_for({'segments': [segment('early', 'Lan sở hữu module thanh toán.', NOW - 900000),
                                        segment('late', 'Demo đang chạy.', NOW - 1000)]},
                          {'wiki/shared.md': 'Mã sản phẩm Aster dùng Redis.'})
    selected, trace = lookup_voice_sources(sources, [], voice_tool_calls(json.dumps({'tool_calls': [
        {'name': 'search_meeting', 'query': 'thanh toán'},
        {'name': 'search_shared_documents', 'query': 'Redis'}]})), NOW)
    assert {s['key'] for s in selected} == {'segment:early', 'doc:wiki/shared.md:0'}
    assert [s['id'] for s in selected] == ['s0', 's2']
    assert all(t['source_count'] == 1 for t in trace)
    recent, _ = lookup_voice_sources(sources, [], [{'name': 'get_recent_transcript', 'query': ''}], NOW)
    assert [s['key'] for s in recent] == ['segment:late']
    for call in [{'name': 'read_file', 'query': '/etc/passwd'}, {'name': 'search_meeting', 'query': ''},
                 {'name': 'search_shared_documents', 'query': 'x', 'path': 'wiki/private.md'}]:
        with pytest.raises(ValueError): voice_tool_calls(json.dumps({'tool_calls': [call]}))


def test_public_routes_never_build_web_queries_from_private_context():
    from shared.voice_knowledge import voice_route
    assert voice_route('Tìm trên web về Redis mới nhất?') == ('web', 'Redis mới nhất?')
    assert voice_route('ASR là gì?')[0] == 'general'
    assert voice_route('Kiến thức chung: giải thích VAD')[0] == 'general'
    for question in ['Deadline đã chốt là gì?', 'Ngân sách của chúng ta là gì?', 'Vậy ai phụ trách?', 'Tìm thông tin này giúp tôi']:
        assert voice_route(question)[0] == 'meeting'


def test_verification_failures_are_distinguished_without_exposing_provider_output():
    from shared.voice_knowledge import verify_voice_reply
    raw = json.dumps({'claims': [{'text': 'Lan làm demo.', 'source_ids': ['s0']}]})
    sources = [{'id': 's0', 'quote': 'Lan làm demo.'}]
    assert json.loads(verify_voice_reply(raw, 'Ai?', sources, lambda _: '{"approved":false}', diagnostics=True))['reason'] == 'verification_rejected'
    def fail(_): raise TimeoutError('secret provider response')
    result = verify_voice_reply(raw, 'Ai?', sources, fail, diagnostics=True)
    assert json.loads(result)['reason'] == 'verification_unavailable' and 'secret' not in result


def test_worker_dispatches_voice_plan_to_selected_completion_without_treating_it_as_claims(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_PLAN_SYSTEM
    identifier='synthetic-plan';events=[];seen=[]
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-'+identifier)
    prompt=json.dumps({'mode':'voice_plan','question':'Demo?','available_tools':['search_meeting'],'sources':[]})
    monkeypatch.setattr(engine,'start_prompt',lambda _:PREFIX+json.dumps({'request_id':identifier,'text':prompt}))
    def complete(text,**kwargs):
        seen.append((text,kwargs))
        return SimpleNamespace(text=json.dumps({'tool_calls':[{'name':'search_meeting','query':'demo'}]}))
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    stream=SimpleNamespace(xadd=lambda _,entry:events.append(json.loads(entry['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic-out',{})
    assert seen[0][1]['system']==VOICE_PLAN_SYSTEM
    assert json.loads(events[0]['text'])=={'tool_calls':[{'name':'search_meeting','query':'demo'}]}
    assert events[-1]['type']=='turn-complete'


def test_worker_social_classification_is_structured_short_and_has_no_tools_or_room_sources(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_INTENT_SYSTEM
    identifier='synthetic-intent';events=[];seen=[];timeouts=[]
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-'+identifier)
    prompt=json.dumps({'mode':'voice_intent','question':'Cảm ơn TINA nha.','sources':['DO NOT PASS']})
    monkeypatch.setattr(engine,'start_prompt',lambda _:PREFIX+json.dumps({'request_id':identifier,'text':prompt}))
    def complete(text,schema,**kwargs):
        seen.append((json.loads(text),schema,kwargs))
        return SimpleNamespace(text='{"intent":"thanks"}')
    def provider(**kwargs):
        timeouts.append(kwargs['timeout'])
        return SimpleNamespace(complete_structured=complete)
    monkeypatch.setattr(engine,'completion_from_env',provider)
    stream=SimpleNamespace(xadd=lambda _,entry:events.append(json.loads(entry['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic-out',{})
    assert timeouts==[4]
    assert seen[0][0]=={'question':'Cảm ơn TINA nha.'}
    assert seen[0][1]['properties']['intent']['enum']==['greeting','thanks','identity','capabilities','meeting']
    assert seen[0][2]['system']==VOICE_INTENT_SYSTEM
    assert json.loads(events[0]['text'])=={'intent':'thanks'}
    assert events[-1]['type']=='turn-complete'


@pytest.mark.parametrize('question,intent',[
    ('TINA ơi, bạn là ai?','identity'),('Bạn làm được gì?','capabilities'),('Cảm ơn bạn!','thanks'),
    ('Hello!','greeting'),('Gửi email cho nhóm','action'),('Create a ticket for this bug','action')])
def test_assistant_intent_is_bounded_and_never_claims_actions_were_performed(question,intent):
    from shared.voice_knowledge import assistant_intent,assistant_reply,voice_route
    assert assistant_intent(question)==intent
    assert voice_route(question)[0]=='assistant'
    text=assistant_reply(question,{'include_transcript':True,'documents':[],'allow_web_search':False})
    assert 'Wiki' not in text and 'tìm web' not in text
    if intent=='action':assert 'chưa hỗ trợ' in text or 'cannot' in text


def test_intent_router_does_not_turn_compound_meeting_questions_into_social_replies():
    from shared.voice_knowledge import voice_route
    for q in ('Cảm ơn, deadline của chúng ta là gì?', 'Bạn là ai và ai phụ trách demo?',
              'Kế hoạch triển khai của nhóm là gì?', 'Tài liệu dự án mới là gì?'):
        assert voice_route(q)[0]=='meeting'
    assert voice_route('Retrieval augmented generation là gì?')[0]=='general'
    assert voice_route('Tìm trên web về lịch sử TINA')[0]=='web'


def test_repair_keeps_supported_part_and_asks_for_missing_detail_after_reverification():
    from shared.voice_knowledge import verify_voice_reply
    raw=json.dumps({'claims':[{'text':'Lan làm demo, hạn 10/11.','source_ids':['s0']}]})
    sources=[{'id':'s0','quote':'Lan làm demo.'}];repairs=[];reviews=[]
    fixed=json.dumps({'claims':[{'text':'Lan làm demo.','source_ids':['s0']}],
                      'follow_up':'Bạn có thể xác nhận hạn bàn giao không?'})
    def repair(prompt):repairs.append(json.loads(prompt));return fixed
    def review(prompt):reviews.append(json.loads(prompt));return '{"approved":true}'
    result=json.loads(verify_voice_reply(raw,'Ai làm và hạn khi nào?',sources,review,repair=repair,diagnostics=True))
    assert result['verification']==['numeric_mismatch','approved']
    assert result['follow_up'].endswith('?') and result['claims'][0]['text']=='Lan làm demo.'
    assert repairs[0]['rejection']=={'reason':'numeric_mismatch','claim_indexes':[0]}
    assert len(repairs)==1 and len(reviews)==1 and reviews[0]['reply']['follow_up']==result['follow_up']


def test_semantic_repair_is_once_and_cannot_publish_a_second_rejected_reply():
    from shared.voice_knowledge import verify_voice_reply
    raw=json.dumps({'claims':[{'text':'Minh đã chốt.','source_ids':['s0']}]})
    sources=[{'id':'s0','quote':'Minh chưa chốt.'}];calls=[]
    def repair(prompt):calls.append(json.loads(prompt));return raw
    result=json.loads(verify_voice_reply(raw,'Đã chốt chưa?',sources,
        lambda _:'{"approved":false,"reason":"contradiction","claim_indexes":[0]}',repair=repair,diagnostics=True))
    assert result=={'claims':[],'reason':'verification_rejected','verification':['contradiction','contradiction']}
    assert len(calls)==1


def test_failed_review_skips_repair_and_forged_repair_sources_are_rejected():
    from shared.voice_knowledge import verify_voice_reply
    raw=json.dumps({'claims':[{'text':'Lan làm demo.','source_ids':['s0']}]})
    sources=[{'id':'s0','quote':'Lan làm demo.'}];calls=[]
    def repair(prompt):calls.append(prompt);return raw.replace('s0','forged')
    result=json.loads(verify_voice_reply(raw,'Ai?',sources,lambda _:'not json',repair=repair,diagnostics=True))
    assert result['reason']=='verification_unavailable' and not calls
    result=json.loads(verify_voice_reply(raw,'Ai?',sources,lambda _:'{"approved":false}',repair=repair,diagnostics=True))
    assert result['claims']==[] and result['verification']==['unsupported_claim','repair_failed']
    for body in ({'claims':[],'follow_up':'Bạn nói rõ?'}, {'claims':json.loads(raw)['claims'],'follow_up':'Chắc chắn.'}):
        with pytest.raises(ValueError):validate_voice_answer(json.dumps(body),sources)


def test_conversational_reply_keeps_citations_and_missing_detail_through_verification():
    from shared.voice_knowledge import verify_voice_reply
    raw = json.dumps({'claims': [{'text': 'Lan phụ trách demo.', 'source_ids': ['s0']}],
                      'follow_up': 'Bạn có số điện thoại của Lan không?'})
    source = {'id': 's0', 'quote': 'Lan phụ trách demo.'}
    seen = []
    def review(prompt):
        seen.append(json.loads(prompt))
        return '{"approved":true}'
    result = json.loads(verify_voice_reply(raw, 'Ai làm demo và số điện thoại là gì?', [source], review, diagnostics=True))
    assert result['claims'][0]['source_ids'] == ['s0'] and result['verification'] == ['approved']
    assert seen[0]['reply']['follow_up'] == result['follow_up']
    assert seen[0]['sources'] == [source]


@pytest.mark.parametrize('recovered,review,expected', [
    ('{"claims":[{"text":"Lan làm demo.","source_ids":["s0"]}]}', '{"approved":true}', 'Lan làm demo.'),
    ('plain text again', '{"approved":true}', None),
    ('{"claims":[{"text":"Minh làm demo.","source_ids":["s0"]}]}', '{"approved":false,"reason":"contradiction"}', None),
])
def test_malformed_voice_reply_gets_one_regeneration_and_still_requires_source_review(monkeypatch, recovered, review, expected):
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_FORMAT_SYSTEM, VERIFY_SYSTEM
    identifier = 'format-recovery'; events = []; systems = []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-' + identifier)
    source = {'mode': 'voice', 'question': 'Ai làm demo và số điện thoại là gì?',
              'sources': [{'id': 's0', 'quote': 'Lan làm demo.'}], 'tools_remaining': 0}
    calls = iter(['Lan làm demo. {"claims":[]}', recovered, review, '{"claims":[]}', review])
    def complete(prompt, **kwargs):
        systems.append(kwargs.get('system')); return SimpleNamespace(text=next(calls))
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete=complete))
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': identifier, 'text': json.dumps(source)})}})
    assert systems.count(VOICE_FORMAT_SYSTEM) == 1
    output = [json.loads(e['text']) for e in events if e['type'] == 'message-delta']
    if expected:
        assert output[0]['claims'][0]['text'] == expected and VERIFY_SYSTEM in systems
        assert output[0]['verification'] == ['approved']
    else:
        assert not output or not output[0]['claims']
    assert events[-1]['type'] == 'turn-complete'


@pytest.mark.parametrize('provider_error', [False, True])
def test_voice_worker_distinguishes_empty_evidence_from_provider_failure(monkeypatch, provider_error):
    from types import SimpleNamespace
    from llm.errors import LLMError
    from shared.meeting_knowledge import PREFIX
    from worker import engine

    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-missing')
    events, calls = [], []

    def complete(prompt, **kwargs):
        calls.append(prompt)
        if provider_error:
            raise LLMError('fixture transport failure')
        return SimpleNamespace(text='{"claims":[],"follow_up":"Bạn có thể cung cấp số điện thoại không?"}')

    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete=complete))
    stream = SimpleNamespace(xadd=lambda _, event: events.append(json.loads(event['event'])), expire=lambda *_: None)
    source = {'mode': 'voice', 'question': 'Số điện thoại của Lan là gì?',
              'sources': [{'id': 's0', 'quote': 'Lan phụ trách bản demo.'}], 'tools_remaining': 0}
    payload = {'request_id': 'missing', 'text': json.dumps(source)}
    engine._run_meeting_knowledge(stream, 'fixture', {'entrypoint': {'inline': PREFIX + json.dumps(payload)}})
    assert len(calls) == 1
    assert [json.loads(event['text']) for event in events if event['type'] == 'message-delta'] == (
        [] if provider_error else [{'claims': [], 'verification': []}]
    )
    assert events[-1]['type'] == 'turn-complete'


def test_interrupted_prefix_is_intent_only_and_source_guard_revocation_discards_it():
    ref={'key':'doc:wiki/demo.md:0','fingerprint':'a'*64}
    turn={'question':'Demo?','answer':'Lan phụ trách demo.','sources':[],
          'heard_partial':True,'heard_source_guards':[ref],'created_at_ms':NOW-1}
    assert current_history([turn],[ref],NOW)==[turn]
    assert current_history([turn],[],NOW)==[]
    assert current_history([turn],[ref|{'fingerprint':'b'*64}],NOW)==[]
