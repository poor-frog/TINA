"""Bounded Decimal/date tools. No eval, arbitrary calls, implicit units or guessed operands."""
import ast
import base64
import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation, localcontext
from zoneinfo import ZoneInfo

from shared.meeting_knowledge import digest
from shared.voice_knowledge import context_handle


def calculation_request(query):
    if len(query)>200: raise ValueError('Calculation query too large')
    body=json.loads(query)
    if not isinstance(body,dict) or set(body)-{'expression','start_date','end_date','context_handles'}:
        raise ValueError('Invalid calculation fields')
    handles=body.get('context_handles',[])
    if (not isinstance(handles,list) or len(handles)>2
            or any(not isinstance(h,str) or not re.fullmatch(r'ctx-[0-9a-f]{64}',h) for h in handles)
            or len(set(handles))!=len(handles)):
        raise ValueError('Invalid calculation sources')
    return body,handles


def calculate_source(query, question, candidates, *, allowed_handles=None, replay=False, today=None):
    body,handles=calculation_request(query)
    if allowed_handles is not None and any(h not in allowed_handles for h in handles):
        raise ValueError('Calculation context was not returned in this turn')
    by_handle={context_handle(s):s for s in candidates if s['kind']!='calculation'}
    if any(h not in by_handle for h in handles): raise ValueError('Calculation source was revoked')
    parents=[by_handle[h] for h in handles]
    inputs='\n'.join([question,*[p['quote'] for p in parents]])
    reference=today or datetime.now(ZoneInfo('Asia/Ho_Chi_Minh')).date()
    if 'expression' in body:
        if 'start_date' in body or 'end_date' in body: raise ValueError('Choose arithmetic or dates')
        expression=body['expression']
        if isinstance(expression,str): expression=expression.strip()
        if not isinstance(expression,str) or not 1<=len(expression)<=100 or not re.fullmatch(r'[\d. +*/%()\-]+',expression):
            raise ValueError('Invalid arithmetic expression')
        tree=ast.parse(expression,mode='eval')
        if len(list(ast.walk(tree)))>64: raise ValueError('Arithmetic exceeds bound')
        literals=[ast.get_source_segment(expression,node) for node in ast.walk(tree) if isinstance(node,ast.Constant)]
        known={Decimal(n) for n in re.findall(r'(?<![\w.,])\d+(?:\.\d+)?(?!\w|[.,]\d)',inputs)}
        if not replay and any(n is None or Decimal(n) not in known for n in literals): raise ValueError('Operand missing from approved input')
        def evaluate(node):
            if isinstance(node,ast.Expression): return evaluate(node.body)
            if isinstance(node,ast.Constant) and type(node.value) in (int,float):
                raw=ast.get_source_segment(expression,node)
                if raw is None or len(raw)>24: raise ValueError('Number exceeds bound')
                return Decimal(raw)
            if isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.USub,ast.UAdd)):
                number=evaluate(node.operand);return -number if isinstance(node.op,ast.USub) else number
            if isinstance(node,ast.BinOp) and isinstance(node.op,(ast.Add,ast.Sub,ast.Mult,ast.Div,ast.Mod)):
                left,right=evaluate(node.left),evaluate(node.right)
                if isinstance(node.op,ast.Add): value=left+right
                elif isinstance(node.op,ast.Sub): value=left-right
                elif isinstance(node.op,ast.Mult): value=left*right
                elif isinstance(node.op,ast.Div): value=left/right
                else: value=left%right
                if not value.is_finite() or abs(value)>Decimal('1e24'): raise ValueError('Result exceeds bound')
                return value
            raise ValueError('Unsupported arithmetic')
        try:
            with localcontext() as ctx:
                ctx.prec=28
                result=evaluate(tree)
            answer=format(result,'f').rstrip('0').rstrip('.') if '.' in format(result,'f') else format(result,'f')
        except (InvalidOperation,ArithmeticError): raise ValueError('Invalid arithmetic') from None
        if len(answer)>64: raise ValueError('Result exceeds bound')
        quote=f'Phép tính: {expression}. Kết quả (tối đa 28 chữ số có nghĩa): {answer}.'
    else:
        def resolve(value):
            if value=='today': return reference
            if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value): raise ValueError('Use explicit ISO dates')
            if not replay and value not in inputs: raise ValueError('Date missing from approved input')
            return date.fromisoformat(value)
        start,end=resolve(body.get('start_date')),resolve(body.get('end_date'))
        quote=(f'Khoảng ngày lịch: {start.isoformat()} → {end.isoformat()}: {(end-start).days} ngày. '
               f'Tính bằng ngày kết thúc trừ ngày bắt đầu, không phải ngày làm việc. Ngày tham chiếu Asia/Ho_Chi_Minh: {reference.isoformat()}.')
    canonical=json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=False)
    key='calc:'+base64.urlsafe_b64encode(canonical.encode()).decode().rstrip('=')
    fingerprint=digest([quote,[(p['key'],p['fingerprint']) for p in parents]])
    return {'kind':'calculation','key':key,'fingerprint':fingerprint,'quote':quote,
            'calculation_query':canonical},parents


def calculation_from_key(key, candidates):
    if not key.startswith('calc:') or len(key)>1024: raise ValueError('Invalid calculation key')
    query=base64.b64decode(key[5:]+'='*(-len(key[5:])%4),altchars=b'-_',validate=True).decode()
    return calculate_source(query,'',candidates,replay=True)[0]
