import {describe,expect,it} from 'vitest';
import {formatTranscript} from './format';

describe('comparison-free transcript display formatting',()=>{
  it.each([
    ['Nhanh hơn mười chín phần trăm.', 'Nhanh hơn 19%.', 'number'],
    ['Ngân sách một trăm triệu đồng.', 'Ngân sách 100 triệu đồng.', 'number'],
    ['Mức âm hai phẩy năm phần trăm.', 'Mức -2,5%.', 'number'],
    ['Có hai đứa con.', 'Có 2 đứa con.', 'number'],
    ['Ngày mười lăm tháng mười một năm hai nghìn không trăm hai mươi sáu.', 'Ngày 15/11/2026.', 'date'],
    ['hẹn ngày hai mươi chín tháng hai năm hai nghìn không trăm hai mươi tư.', 'hẹn ngày 29/02/2024.', 'date'],
    ['hẹn ngày mười lăm tháng mười một.', 'hẹn ngày 15/11.', 'date'],
    ['lúc chín giờ ba mươi sáng.', 'lúc 09:30.', 'time'],
    ['lúc ba giờ mười lăm chiều.', 'lúc 15:15.', 'time'],
    ['lúc mười hai giờ sáng.', 'lúc 00:00.', 'time'],
    ['lúc chín giờ rưỡi sáng.', 'lúc 09:30.', 'time'],
    ['Số điện thoại là không chín một hai ba bốn năm sáu bảy tám.', 'Số điện thoại là 0912345678.', 'phone'],
    ['điện thoại: cộng tám bốn chín một hai ba bốn năm sáu bảy tám.', 'điện thoại: +84912345678.', 'phone'],
    ['PostgreSQL phiên bản mười bảy.', 'PostgreSQL phiên bản 17.', 'technical'],
    ['Python phiên bản ba chấm mười một.', 'Python phiên bản 3.11.', 'technical'],
    ['mã A gạch ngang một hai ba.', 'mã A-123.', 'technical'],
    ['mã chữ hoa a gạch ngang số không một hai.', 'mã A-012.', 'technical'],
    ['mã chữ thường a gạch dưới một hai.', 'mã a_12.', 'technical'],
    ['mã O gạch ngang một hai.', 'mã O-12.', 'technical'],
  ])('formats an explicit %s without modifying other text',(raw,display,kind)=>{
    const result=formatTranscript(raw,true);
    expect(result.text).toBe(display);expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe(kind);
    for(const change of [...result.changes].reverse()){
      expect(raw.slice(change.start,change.end)).toBe(change.original);
    }
    expect(result.original).toBe(raw);expect(formatTranscript(display,true).text).toBe(display);
  });

  it.each([
    'Hẹn mai và thứ Sáu tới.', 'Làm mười năm rồi.', 'Chưa chốt trong năm nay.', 'Không thay đổi.',
    'Ngày ba mươi mốt tháng hai năm hai nghìn không trăm hai mươi sáu.',
    'ngày hai mươi chín tháng hai năm hai nghìn không trăm hai mươi ba.',
    'ngày mười lăm tháng mười ba.',
    'ngày mười lăm tháng hai mươi.',
    'ngày mười lăm tháng mười một năm hai nghìn không trăm hai mươi ba mươi.',
    'hẹn ngày mười lăm tháng mười một năm sau.',
    'lúc hai mươi lăm giờ ba mươi.', 'chín giờ ba mươi.',
    'lúc chín giờ kém mười phút.', 'lúc chín giờ hơn mười phút.',
    'lúc ba giờ chừng mười phút.',
    'số điện thoại là không chín một.',
    'Số điện thoại không chín một hai ba bốn năm sáu bảy tám chín một hai ba bốn năm.',
    'mã ô gạch ngang một hai.', 'mã A một hai.', 'mã a gạch ngang i một.',
    'Python ba chấm mười một.', 'phiên bản mới nhất.',
    'https://example.com/mười-hai `mười chín phần trăm` email@example.com',
    '⟦mười chín phần trăm⟧{CSRC 1↔2}',
  ])('leaves ambiguous/protected input unchanged: %s',raw=>{
    expect(formatTranscript(raw,true).text).toBe(raw);
    expect(formatTranscript(raw,true).changes).toEqual([]);
  });

  it('only changes final text and never merges separate segments',()=>{
    const raw='Mức mười chín phần trăm.';
    expect(formatTranscript(raw,false)).toMatchObject({original:raw,text:raw,changes:[]});
    expect(formatTranscript('mười',true).text).toBe('mười');
    expect(formatTranscript('chín phần trăm',true).text).toBe('9%');
    expect(formatTranscript('mười chín phần trăm',true,['mười','chín phần trăm']).text).toBe('mười 9%');
    expect(formatTranscript('mười chín phần trăm',true,['stale source']).text).toBe('mười chín phần trăm');
  });

  it('records nonoverlapping original offsets across multiple format types',()=>{
    const raw='Hẹn ngày mười lăm tháng mười một, mức mười chín phần trăm; mã A gạch ngang một hai.';
    const result=formatTranscript(raw,true);
    expect(result.text).toBe('Hẹn ngày 15/11, mức 19%; mã A-12.');
    expect(result.changes.map(c=>c.kind)).toEqual(['date','number','technical']);
    let cursor=0,reconstructed='';
    for(const c of result.changes){expect(c.start).toBeGreaterThanOrEqual(cursor);reconstructed+=raw.slice(cursor,c.start)+c.replacement;cursor=c.end;}
    expect(reconstructed+raw.slice(cursor)).toBe(result.text);
  });
});
