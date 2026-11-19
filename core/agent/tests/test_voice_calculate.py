import json
from datetime import date

import pytest

from shared.voice_calculate import calculate_source,calculation_from_key
from shared.voice_knowledge import context_handle


def query(**kwargs):return json.dumps(kwargs,separators=(',',':'))


def test_decimal_arithmetic_is_reproducible_and_requires_spoken_operands():
    source,parents=calculate_source(query(expression='0.1+0.2'),'Tính 0.1 cộng 0.2',[])
    assert '0.3.' in source['quote'] and parents==[]
    assert calculation_from_key(source['key'],[])==source
    for expression in ['1+999','.9+.1','__import__("os")','2**1000000000','1/0','[1]','abs(1)']:
        with pytest.raises((ValueError,SyntaxError)):
            calculate_source(query(expression=expression),'Tính 1 và 2',[])


def test_calculation_sources_require_current_handles_and_bind_the_full_operand_fingerprint():
    parent={'kind':'document','key':'doc:a','fingerprint':'a'*64,'quote':'Chi phí là 100 và 200.'}
    handle=context_handle(parent);body=query(expression='100+200',context_handles=[handle])
    result,parents=calculate_source(body,'Tính tổng chi phí',[parent],allowed_handles=[handle])
    assert '300.' in result['quote'] and parents==[parent]
    for rows,allowed in [([], [handle]),([parent],[]),([parent|{'fingerprint':'b'*64}],[handle])]:
        with pytest.raises(ValueError):calculate_source(body,'Tính tổng',rows,allowed_handles=allowed)
    with pytest.raises(ValueError):calculation_from_key(result['key'],[])


def test_date_differences_are_calendar_days_with_explicit_dates_or_server_today():
    result,_=calculate_source(query(start_date='today',end_date='2026-11-20'),
        'Đến 2026-11-20 còn mấy ngày?',[],today=date(2026,11,12))
    assert '8 ngày' in result['quote'] and '2026-11-12' in result['quote']
    result,_=calculate_source(query(start_date='2026-11-20',end_date='2026-11-12'),
        '2026-11-20 và 2026-11-12',[],today=date(2026,11,12))
    assert '-8 ngày' in result['quote']
    for end in ['thứ Sáu','2026-02-30','2030-01-01']:
        with pytest.raises(ValueError):calculate_source(query(start_date='today',end_date=end),'Hạn 2026-11-20',[])


@pytest.mark.parametrize('body',[[],{'expression':'1+1','unexpected':True},{'expression':'1+1','end_date':'today'},
    {'expression':'1+1','context_handles':['other']},{'expression':'1'*1000}])
def test_invalid_and_oversized_requests_are_refused(body):
    with pytest.raises((ValueError,SyntaxError)):calculate_source(json.dumps(body),'1',[])
