"""Comparison-only Vietnamese quantities preserve evidence and the semantic review boundary."""
from copy import deepcopy
import json

import pytest

from shared.voice_knowledge import verify_voice_reply


def reply(text):
    return json.dumps({'claims':[{'text':text,'source_ids':['s0']}]},ensure_ascii=False)


@pytest.mark.parametrize('quote,claim', [
    ('Nhanh hơn mười chín phần trăm.', 'Nhanh hơn 19%.'),
    ('Tiết kiệm hai mươi tư phần trăm hạn mức.', 'Tiết kiệm 24 phần trăm hạn mức.'),
    ('Tăng 19%.', 'Tăng mười chín phần trăm.'),
    ('Tăng mười chín phẩy năm phần trăm.', 'Tăng 19,5%.'),
    ('SLA là 99,9 phần trăm.', 'SLA là 99.9%.'),
    ('Tỷ lệ một phẩy không năm phần trăm.', 'Tỷ lệ 1.05%.'),
    ('Ngân sách một trăm triệu đồng.', 'Ngân sách 100 triệu VND.'),
    ('Ngân sách 100 triệu đồng.', 'Ngân sách một trăm triệu đồng.'),
    ('Chi phí một tỷ hai trăm triệu đồng.', 'Chi phí 1200 triệu đồng.'),
    ('Khoản tiền hai trăm tỷ đô la.', 'Khoản tiền 200 tỷ USD.'),
    ('Mức âm mười chín phần trăm.', 'Mức -19%.'),
    ('Mức âm mười chín phần trăm.', 'Mức −19%.'),
    ('Mức dương hai mươi tư phần trăm.', 'Mức +24%.'),
    ('Số lượng hai đứa con.', 'Số lượng 2 đứa con.'),
    ('PostgreSQL 17.', 'PostgreSQL 17.'),
    ('Hạn 12/04/2026.', 'Hạn 12/04/2026.'),
    ('Hạn 2026-04-12 lúc 09:30.', 'Hạn 2026-04-12 lúc 09:30.'),
    ('Mức 1.000 triệu đồng.', 'Mức 1.000 triệu đồng.'),
    ('Tăng mười chín phần trăm.', 'Tăng 19.0 %.'),
    ('Mức không phần trăm.', 'Mức 0%.'),
    ('Chi phí một trăm linh năm triệu đồng.', 'Chi phí 105 triệu đồng.'),
    ('Chi phí một phẩy năm triệu đồng.', 'Chi phí 1,5 triệu VND.'),
    ('Chi phí 100 triệu đồng.', 'Chi phí 0,1 tỷ VND.'),
    ('Mức 1.000 triệu đồng.', 'Mức 1000 triệu đồng.'),
    ('Giá 150.000.000 đồng/lượng.', 'Giá 150 triệu VND mỗi lượng.'),
    ('Giá 15.000.000đ/chỉ.', 'Giá 15 triệu đồng một chỉ.'),
    ('Giá 150,5 triệu đồng/lượng.', 'Giá 150.500.000₫/lượng.'),
    ('Giá 150,000,000 VND/lượng.', 'Giá 150 triệu đồng/lượng.'),
    ('Chi phí 1.234,50 EUR.', 'Chi phí 1234,5 euro.'),
    ('Chi phí 1,234.50 USD.', 'Chi phí 1234.5 đô la.'),
    ('Giá 150.000.000,50 đồng/lượng.', 'Giá 150000000,5 đồng/lượng.'),
    ('Chi phí 150.000 đồng.', 'Chi phí 150 nghìn đồng.'),
    ('Chi phí -150.000.000 đồng.', 'Chi phí âm 150 triệu đồng.'),
])
def test_equivalent_numbers_reach_review_without_rewriting_sources_or_reply(quote,claim):
    sources=[{'id':'s0','key':'source-a','fingerprint':'a'*64,'quote':quote}]
    original=deepcopy(sources);raw=reply(claim);calls=[]
    def review(prompt):
        calls.append(json.loads(prompt))
        return '{"approved":true}'
    assert verify_voice_reply(raw,'Theo nguồn là bao nhiêu?',sources,review)==raw
    assert len(calls)==1 and calls[0]['sources']==original
    assert calls[0]['reply']['claims'][0]['text']==claim and sources==original


@pytest.mark.parametrize('quote,claim', [
    ('Mức mười chín phần trăm.', 'Mức 24%.'),
    ('Mức 19%.', 'Mức hai mươi tư phần trăm.'),
    ('Ngân sách 100 triệu đồng.', 'Ngân sách 100 tỷ đồng.'),
    ('Ngân sách một trăm triệu đồng.', 'Ngân sách một trăm tỷ đồng.'),
    ('Ngân sách 100 tỷ đồng.', 'Ngân sách 100 triệu đồng.'),
    ('Khoản tiền 100 USD.', 'Khoản tiền 100 VND.'),
    ('Mức -19%.', 'Mức 19%.'),
    ('Mức −19%.', 'Mức 19%.'),
    ('Mức 19%.', 'Mức âm mười chín phần trăm.'),
    ('Mức 19%.', 'Mức 19 triệu đồng.'),
    ('Mức mười chín phẩy năm phần trăm.', 'Mức 19.6%.'),
    ('Số một phẩy không năm.', 'Số 1.5.'),
    ('Hạn 12/04/2026.', 'Hạn 13/04/2026.'),
    ('Hạn 2026-04-12 lúc 09:30.', 'Hạn 2026-04-13 lúc 09:30.'),
    ('Mức 1.000.', 'Mức 1000.'),
    ('Chi phí 1,000 USD.', 'Chi phí 1000 USD.'),
    ('Chi phí 1.000 USD.', 'Chi phí 1000 USD.'),
    ('Chi phí 1.000 VND.', 'Chi phí 1000 VND.'),
    ('Chi phí -150.000.000 đồng.', 'Chi phí 150 triệu đồng.'),
    ('Giá 150.000.000 đồng/lượng.', 'Giá 150 tỷ đồng/lượng.'),
    ('Giá 150 triệu đồng/lượng.', 'Giá 150 triệu đồng/chỉ.'),
    ('Giá 150 triệu đồng/chỉ.', 'Giá 150 triệu đồng.'),
    ('Giá 150 triệu đồng/lượng.', 'Giá 150 triệu USD/lượng.'),
    ('Bản 1.000.000.', 'Bản 1000000.'),
    ('Hạn 18.11.2026.', 'Hạn 18112026.'),
    ('Giá 150 triệu đồng/lượng.', 'Giá 150,5 triệu đồng/lượng.'),
    ('Chưa chốt trong năm nay.', 'Đã chốt 5.'),
    ('Không thay đổi ngân sách.', 'Ngân sách 0.'),
    ('Lưu trữ mười năm.', 'Lưu trữ 15 năm.'),
    ('Lưu trữ hai mươi năm.', 'Lưu trữ 25 năm.'),
    ('Lưu trữ một trăm năm.', 'Lưu trữ 105 năm.'),
    ('Số bị ngắt: một trăm linh.', 'Số 100.'),
    ('Danh sách: mười\nchín.', 'Số 19.'),
])
def test_different_or_ambiguous_quantities_are_blocked_before_model_review(quote,claim):
    def review(_):pytest.fail('Mismatched quantities must not reach semantic approval')
    result=json.loads(verify_voice_reply(reply(claim),'Bao nhiêu?', [{'id':'s0','quote':quote}],review,diagnostics=True))
    assert result['claims']==[] and result['verification']==['numeric_mismatch']


@pytest.mark.parametrize('quote,claim', [
    ('Chưa duyệt một trăm triệu đồng.', 'Đã duyệt 100 triệu đồng.'),
    ('Lan đề xuất 100 triệu; Minh nói 120 triệu; chưa thống nhất.', 'Đã chốt 100 triệu.'),
    ('Lan phụ trách demo, ngân sách mười chín triệu đồng.', 'Minh phụ trách demo, ngân sách 19 triệu đồng.'),
])
def test_number_equivalence_never_bypasses_negation_conflict_or_name_review(quote,claim):
    sources=[{'id':'s0','quote':quote}];calls=[]
    def review(prompt):
        calls.append(json.loads(prompt))
        return '{"approved":false,"reason":"contradiction"}'
    result=json.loads(verify_voice_reply(reply(claim),'Theo nguồn?',sources,review,diagnostics=True))
    assert result['claims']==[] and result['verification']==['contradiction']
    assert len(calls)==1 and calls[0]['sources']==sources


def test_unit_mismatch_keeps_the_existing_single_repair_and_review_budget():
    sources=[{'id':'s0','quote':'Ngân sách một trăm triệu đồng.'}];repairs=[]
    def repair(prompt):repairs.append(json.loads(prompt));return reply('Ngân sách 100 triệu đồng.')
    result=json.loads(verify_voice_reply(reply('Ngân sách 100 tỷ đồng.'),'Bao nhiêu?',sources,
        lambda _:'{"approved":true}',repair=repair,diagnostics=True))
    assert result['verification']==['numeric_mismatch','approved']
    assert result['claims'][0]['text']=='Ngân sách 100 triệu đồng.'
    assert len(repairs)==1 and repairs[0]['sources']==sources


def test_citation_boundaries_cannot_join_two_cardinals_into_a_different_number():
    raw=json.dumps({'claims':[{'text':'Số 19.','source_ids':['s0','s1']}]})
    sources=[{'id':'s0','quote':'mười'},{'id':'s1','quote':'chín'}]
    result=json.loads(verify_voice_reply(raw,'Bao nhiêu?',sources,
        lambda _:pytest.fail('Two separate quotes cannot form nineteen'),diagnostics=True))
    assert result['verification']==['numeric_mismatch'] and not result['claims']


def test_non_quantity_scale_words_do_not_add_a_spurious_numeric_constraint():
    raw=reply('Tỷ lệ là 19%.')
    sources=[{'id':'s0','quote':'Tỉ lệ là mười chín phần trăm.'}]
    assert verify_voice_reply(raw,'Bao nhiêu?',sources,lambda _:'{"approved":true}')==raw
