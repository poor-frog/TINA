import {afterEach,expect,it} from 'vitest';
import {createTranscriptFeed} from '../../../../extension/src/transcript-feed';

afterEach(()=>document.body.replaceChildren());

it('extension shares final formatting, preserves draft/original, and does not mutate incoming rows',()=>{
  const feed=document.createElement('div'),root=document.createElement('div'),latest=document.createElement('button');
  feed.append(root,latest);document.body.append(feed);
  const view=createTranscriptFeed(feed,root,latest);
  const rows=[{segment_id:'final',speaker:'Lan',text:'Số điện thoại là không chín một hai ba bốn năm sáu bảy tám.',
    completed:true,absolute_start_time:'2026-11-15T10:00:00Z',absolute_end_time:'2026-11-15T10:00:03Z'},
    {segment_id:'draft',speaker:'Lan',text:'mức mười chín phần trăm.',completed:false,
      absolute_start_time:'2026-11-15T10:00:04Z',absolute_end_time:'2026-11-15T10:00:05Z'}];
  const before=JSON.stringify(rows);view.render(rows,'Draft');
  expect(root.querySelector('.transcript-segment')?.textContent).toBe('Số điện thoại là 0912345678. ');
  expect(root.querySelector('details[data-asr-original]')).toBeNull();
  expect(root.textContent).not.toContain('ASR original');
  expect(root.textContent).not.toContain(rows[0].text);
  expect(root.querySelector('.turn-draft')?.textContent).toContain(rows[1].text);
  expect(JSON.stringify(rows)).toBe(before);
  const finalized=rows.map(row=>({...row,completed:true}));view.render(finalized,'Draft','bilingual');
  expect(root.querySelectorAll('.segment-original')[1].textContent).toBe('mức 19%.');
  view.render(rows,'Draft');expect(root.querySelectorAll('.segment-original')).toHaveLength(0);
  view.reset();expect(root.children).toHaveLength(0);
});

it('extension bilingual view does not join separate raw segments into a new quantity',()=>{
  const feed=document.createElement('div'),root=document.createElement('div'),latest=document.createElement('button');
  feed.append(root,latest);document.body.append(feed);const view=createTranscriptFeed(feed,root,latest);
  const rows=['mười','chín phần trăm'].map((text,i)=>({text,segment_id:String(i),completed:true,speaker:'Lan',
    absolute_start_time:'2026-11-15T10:00:00Z',absolute_end_time:'2026-11-15T10:00:03Z'}));
  view.render(rows,'Draft','bilingual',[{group_id:'phrase',members:rows.map(s=>({segment_id:s.segment_id,source_text:s.text})),
    source_text:'mười chín phần trăm',translated_text:'nineteen percent',ready:true,speaker_id:'',speaker_name:'Lan',start_ms:0,end_ms:3000}]);
  expect(root.querySelector('.segment-original')?.textContent).toBe('mười 9%');
  expect(root.querySelector('details[data-asr-original]')).toBeNull();
  expect(rows.map(row=>row.text)).toEqual(['mười','chín phần trăm']);
});
