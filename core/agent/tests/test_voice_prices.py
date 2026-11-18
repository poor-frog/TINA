import json
from datetime import date
import pytest
from shared.voice_prices import checked_prices, gold_request, gold_followup, price_answer, CLARIFICATION

TODAY=date(2026,11,18)
QUOTE='Cập nhật 18/11/2026 lúc 14:30\nĐơn vị: triệu đồng/lượng\nLoại vàng | Mua vào | Bán ra\nSJC | 150,5 | 152\nNhẫn 9999 | 149 | 151'
SOURCES=[{'id':'s0','title':'Synthetic price table','url':'https://example.com','quote':QUOTE}]
def row(**changes):
 return {'source_id':'s0','product':'SJC','side':'buy','amount':'150,5','scale':'triệu','currency':'VND','unit':'lượng',
  'row_quote':'SJC | 150,5 | 152','header_quote':'Loại vàng | Mua vào | Bán ra','unit_quote':'Đơn vị: triệu đồng/lượng',
  'as_of_quote':'Cập nhật 18/11/2026 lúc 14:30',**changes}
def raw(*rows):return json.dumps({'prices':list(rows)},ensure_ascii=False)


def test_price_cells_remain_bound_to_product_unit_date_and_original_url():
 result=price_answer('Giá vàng SJC hôm nay bao nhiêu?',SOURCES,lambda _:raw(row(),row(side='sell',amount='152')),
  lambda _:'{"approved":true}',None,lambda:True,TODAY)
 assert '150.500.000 đồng/lượng' in result['text'] and 'bán ra 152.000.000' in result['text']
 assert '18/11/2026' in result['text'] and 'chưa xác nhận' not in result['text']
 assert result['links']==[{'title':'Synthetic price table','url':'https://example.com'}]
 assert SOURCES[0]['quote']==QUOTE


@pytest.mark.parametrize('changes',[
 {'amount':'150'},{'product':'DOJI'},{'currency':'USD'},{'unit':'chỉ'},{'scale':'nghìn'},
 {'row_quote':'Invented row'},{'as_of_quote':'19/11/2026'},{'source_id':'unknown'},
 {'product':'Nhẫn 9999','row_quote':'Nhẫn 9999 | 149 | 151','amount':'149'},
])
def test_unbound_or_wrong_price_context_is_rejected(changes):
 with pytest.raises((ValueError,KeyError)):
  checked_prices(raw(row(**changes)),SOURCES,gold_request('giá vàng SJC hôm nay'),TODAY)


def test_swapped_buy_sell_prose_must_pass_independent_full_source_review():
 sources=[SOURCES[0]|{'quote':'Cập nhật 18/11/2026. SJC mua vào 150,5, bán ra 152. Đơn vị: triệu đồng/lượng.'}]
 seen=[]
 def review(prompt):
  data=json.loads(prompt);seen.append(data)
  assert data['sources']==sources
  assert data['price_rows'][0]['amount']=='152' and data['price_rows'][0]['side']=='buy'
  return '{"approved":false}'
 result=price_answer('giá vàng SJC hôm nay',sources,lambda _:raw(row(amount='152',row_quote='SJC mua vào 150,5, bán ra 152.',header_quote='SJC mua vào 150,5, bán ra 152.',as_of_quote='Cập nhật 18/11/2026.')),
  review,None,lambda:True,TODAY)
 assert result['reason']=='verification_rejected' and not result.get('text') and len(seen)==1


def test_wrong_markdown_buy_sell_column_is_rejected_before_review():
 with pytest.raises(ValueError,match='Wrong price column'):
  checked_prices(raw(row(amount='152')),SOURCES,gold_request('giá vàng SJC'),TODAY)


@pytest.mark.parametrize('stamp',[None,'Cập nhật 17/11/2026 lúc 14:30'])
def test_unknown_or_old_price_timestamp_cannot_be_spoken_as_today(stamp):
 sources=[SOURCES[0]|{'quote':QUOTE.replace('18/11/2026','17/11/2026')}]
 result=price_answer('giá vàng SJC hôm nay',sources,lambda _:raw(row(as_of_quote=stamp)),
  lambda _:'{"approved":true}',None,lambda:True,TODAY)
 assert 'chưa xác nhận được đây là giá hôm nay' in result['text']


def test_product_clarification_can_resume_only_a_fixed_public_choice():
 history=[{'question':'Giá vàng hôm nay bao nhiêu?','answer':CLARIFICATION,'clarification':True,'created_at_ms':1000}]
 assert gold_followup('SJC',history,2000)=='Giá vàng sjc hôm nay bao nhiêu?'
 for text in ('SJC và token sk-private','transcript của tôi','https://private.example','SJC dự án'):
  assert gold_followup(text,history,2000) is None
 assert gold_followup('SJC',history,32000) is None
 assert gold_followup('SJC',[history[0]|{'question':'Cuộc họp nói gì về giá vàng?'}],2000) is None


def test_repair_is_bounded_and_original_sources_remain_the_only_evidence():
 repairs=[]
 def repair(prompt):
  data=json.loads(prompt);repairs.append(data)
  assert data['sources']==SOURCES and data['mode']=='gold_prices'
  return raw(row())
 result=price_answer('giá vàng SJC hôm nay',SOURCES,lambda _:raw(row(currency='USD')),
  lambda _:'{"approved":true}',repair,lambda:True,TODAY)
 assert len(repairs)==1 and result['verification']==['unsupported_claim','approved']


def test_stop_during_extraction_blocks_review_and_reply():
 alive=[True]
 def current():
  if not alive[0]:raise RuntimeError('stopped')
 def complete(_):alive[0]=False;return raw(row())
 with pytest.raises(RuntimeError):
  price_answer('giá vàng SJC hôm nay',SOURCES,complete,lambda _:pytest.fail('late review'),None,current,TODAY)


def test_unspecified_product_asks_without_retrieval_or_model_calls(monkeypatch):
 from llm import agent_reach
 def forbidden(*a,**k):pytest.fail('Ambiguous product should be clarified first')
 monkeypatch.setattr(agent_reach,'query',forbidden)
 result=agent_reach.answer_public('Giá vàng hôm nay bao nhiêu?',forbidden,forbidden)
 assert result=={'text':CLARIFICATION,'clarification':True,'reason':'clarification','links':[]}


def test_public_gold_rows_use_the_original_page_and_keep_update_clock(monkeypatch):
 from llm import agent_reach
 from shared import voice_prices
 from types import SimpleNamespace
 monkeypatch.setattr(voice_prices,'datetime',SimpleNamespace(now=lambda _:SimpleNamespace(date=lambda:TODAY)))
 monkeypatch.setattr(agent_reach,'query',lambda *a,**k:{'ok':True,'items':[
  {'title':'Synthetic price table','url':'https://example.com','text':QUOTE}]})
 def complete(prompt):
  value=json.loads(prompt)
  assert value['mode']=='gold_prices' and value['sources']==SOURCES
  return raw(row())
 result=agent_reach.answer_public('Giá vàng SJC hôm nay bao nhiêu?',complete,lambda _:'{"approved":true}')
 assert '150.500.000 đồng/lượng' in result['text'] and '14:30' in result['text']
 assert result['verification']==['approved'] and result['links'][0]['url']=='https://example.com'


@pytest.mark.parametrize('stamp',['Cập nhật 19/11/2026','Cập nhật 31/11/2026'])
def test_future_or_invalid_date_cannot_be_authorized(stamp):
 sources=[SOURCES[0]|{'quote':QUOTE+'\n'+stamp}]
 with pytest.raises(ValueError):checked_prices(raw(row(as_of_quote=stamp)),sources,gold_request('giá vàng SJC hôm nay'),TODAY)


def test_independent_source_or_update_time_never_supplies_the_other_side():
 sources=[SOURCES[0],SOURCES[0]|{'id':'s1','url':'https://other.example'}]
 result=price_answer('giá vàng SJC hôm nay',sources,lambda _:raw(row(),row(side='sell',amount='152',source_id='s1')),
  lambda _:'{"approved":true}',None,lambda:True,TODAY)
 assert 'mua vào' in result['text'] and 'bán ra' not in result['text'] and len(result['links'])==1


@pytest.mark.parametrize('sandbox',[False,True])
def test_worker_extracts_price_schema_and_reviews_relations_via_api(monkeypatch,sandbox):
 from types import SimpleNamespace
 import time
 from worker import engine
 from shared.meeting_knowledge import PREFIX
 from shared.voice_prices import PRICE_SYSTEM,PRICE_REVIEW_SYSTEM
 monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach:8080')
 monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-gold')
 monkeypatch.setenv('REDIS_URL','redis://synthetic')
 monkeypatch.setattr('redis.from_url',lambda *a,**k:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
 monkeypatch.setattr('llm.agent_reach.query',lambda *a,**k:{'ok':True,'items':[
  {'title':'Synthetic price table','url':'https://example.com','text':QUOTE}]})
 stages=[]
 def candidate(prompt,system,schema,**kwargs):
  assert system==PRICE_SYSTEM and 'prices' in schema['properties']
  assert set(json.loads(prompt))=={'mode','question','sources','today'}
  stages.append('extract');return raw(row())
 class Provider:
  def complete_structured(self,prompt,*,system,schema):
   if system==PRICE_REVIEW_SYSTEM:
    stages.append('verify')
    assert json.loads(prompt)['sources'][0]['quote']==QUOTE
    return SimpleNamespace(text='{"approved":true}')
   assert not sandbox
   return SimpleNamespace(text=candidate(prompt,system,schema))
 monkeypatch.setattr(engine,'completion_from_env',lambda **k:Provider())
 monkeypatch.setattr('worker.voice_sandbox.complete',candidate)
 events=[];stream=SimpleNamespace(xadd=lambda _,b:events.append(json.loads(b['event'])),expire=lambda *a:None)
 payload={'request_id':'gold','voice_turn':{'meeting_id':1,'holder':'session:turn'},'text':json.dumps({
  'mode':'voice_web','question':'Giá vàng SJC hôm nay bao nhiêu?','use_sandbox_agent':sandbox,
  'retrieval_deadline_ms':int(time.time()*1000)+30000})}
 engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
 result=json.loads(next(e['text'] for e in events if e['type']=='message-delta'))
 assert '150.500.000 đồng/lượng' in result['text'] and result['links']
 assert stages==['extract','verify']


@pytest.mark.parametrize('question',['giá vàng SJC đồng/chỉ','giá vàng SJC USD/lượng','giá vàng SJC bán ra'])
def test_requested_unit_currency_and_side_cannot_be_silently_changed(question):
 assert checked_prices(raw(row()),SOURCES,gold_request(question),TODAY)==[]


def test_spot_usd_per_ounce_retains_its_source_basis():
 source={'id':'s0','title':'Synthetic spot table','url':'https://example.com','quote':
  'Spot gold | 2,350.50\nUSD/oz\nUpdated 2026-11-18 14:30'}
 spot=row(product='Spot gold',side='spot',amount='2,350.50',scale='',currency='USD',unit='ounce',
  row_quote='Spot gold | 2,350.50',header_quote='Spot gold',unit_quote='USD/oz',as_of_quote='Updated 2026-11-18 14:30')
 result=price_answer('giá vàng quốc tế hôm nay',[source],lambda _:raw(spot),lambda _:'{"approved":true}',None,lambda:True,TODAY)
 assert '2.350,5 USD/ounce' in result['text'] and result['links'][0]['url']==source['url']


def test_generic_gold_followup_keeps_only_public_structured_slots():
 last={'question':'Tìm web giá vàng hôm nay bán ra đồng/chỉ?','answer':CLARIFICATION,'clarification':True,'created_at_ms':1000}
 assert gold_followup('SJC',[last],2000)=='Giá vàng sjc bán ra hôm nay VND/chỉ bao nhiêu?'


def test_negative_source_cell_cannot_lose_its_sign():
 sources=[SOURCES[0]|{'quote':QUOTE.replace('150,5','-150,5')}]
 with pytest.raises(ValueError):
  checked_prices(raw(row(row_quote='SJC | -150,5 | 152')),sources,gold_request('giá vàng SJC'),TODAY)


@pytest.mark.parametrize('question',['Giá vàng SJC là gì?','Tại sao giá vàng SJC tăng?',
 'So sánh giá vàng SJC và nhẫn','Dự báo giá vàng SJC tuần tới','Giá vàng SJC hôm qua bao nhiêu?',
 'Giá vàng SJC ngày 10/11/2026','Giá vàng trong dự án của tôi'])
def test_non_quote_requests_keep_the_existing_general_evidence_path(question):
 assert gold_request(question) is None


def test_update_clocks_sort_chronologically_even_with_one_digit_hour():
 older=SOURCES[0]|{'quote':QUOTE.replace('14:30','9:30')}
 newer=SOURCES[0]|{'id':'s1','url':'https://newer.example'}
 result=price_answer('giá vàng SJC hôm nay',[older,newer],lambda _:raw(
  row(as_of_quote='Cập nhật 18/11/2026 lúc 9:30'),row(source_id='s1')),
  lambda _:'{"approved":true}',None,lambda:True,TODAY)
 assert result['links'][0]['url']=='https://newer.example' and '14:30' in result['text']
