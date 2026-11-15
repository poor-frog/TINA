/** Display projection only. Offsets always refer to the unmodified final ASR segment. */
export type TranscriptFormatKind = 'number'|'date'|'time'|'phone'|'technical';
export interface TranscriptFormatChange {start:number;end:number;original:string;replacement:string;kind:TranscriptFormatKind}
export interface FormattedTranscript {original:string;text:string;changes:TranscriptFormatChange[];version:'vi-display.v1'}

const digits:Record<string,number>={không:0,một:1,hai:2,ba:3,bốn:4,năm:5,sáu:6,bảy:7,tám:8,chín:9,mốt:1,tư:4,lăm:5};
const scales:Record<string,number>={nghìn:1e3,ngàn:1e3,triệu:1e6,tỷ:1e9,tỉ:1e9};
const words='không|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mốt|tư|lăm|mười|mươi|trăm|linh|lẻ|nghìn|ngàn|triệu|tỷ|tỉ|phẩy';
const num=`(?:\\d+(?:[.,]\\d+)?|(?:${words})(?:[ \\t]+(?:${words})){0,18})`;
const monthNumber='(?:mười[ \\t]+(?:một|hai)|mười|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|\\d{1,2})';
const boundary='(?![\\p{L}\\p{N}_])';
const pattern=(source:string)=>new RegExp('(?<![\\p{L}\\p{N}_])'+source+boundary,'giu');
const space=(value:string)=>value.toLocaleLowerCase('vi').normalize('NFC').trim().replace(/[ \t]+/g,' ');

function small(input:string[]):number|null {
  let value=0,rest=[...input],separated=false,tens=false;
  if(rest.length>=2&&rest[0] in digits&&rest[1]==='trăm'){
    value=digits[rest[0]]*100;rest=rest.slice(2);
    if(rest[0]==='linh'||rest[0]==='lẻ'){separated=true;rest=rest.slice(1);if(!rest.length)return null;}
  }
  if(rest[0]==='mười'){value+=10;rest=rest.slice(1);tens=true;}
  else if(rest.length>=2&&rest[0] in digits&&digits[rest[0]]>=2&&rest[1]==='mươi'){
    value+=digits[rest[0]]*10;rest=rest.slice(2);tens=true;
  }
  if(rest.length){
    if(rest.length!==1||!(rest[0] in digits)||rest[0]==='năm'&&(tens||value>0&&!separated))return null;
    value+=digits[rest[0]];
  }
  return value;
}

function integer(input:string[]):number|null {
  if(!input.length)return null;
  let total=0,group:string[]=[],previous=1e12;
  for(const word of input){
    if(!(word in scales)){group.push(word);continue;}
    const n=small(group),scale=scales[word];
    if(n===null||!group.length||scale>=previous)return null;
    total+=n*scale;group=[];previous=scale;
  }
  if(group.length){const n=small(group);if(n===null)return null;total+=n;}
  return Number.isSafeInteger(total)?total:null;
}

function number(value:string):number|null {
  const raw=space(value);
  if(/^\d+(?:[.,]\d+)?$/.test(raw)){
    if(/[.,]\d{3}$/.test(raw))return null; // Ambiguous decimal/thousands spelling stays verbatim.
    const n=Number(raw.replace(',','.'));return Number.isFinite(n)&&n<=1e12?n:null;
  }
  const parts=raw.split(' phẩy '),whole=integer(parts[0].split(' '));
  if(whole===null||parts.length>2)return null;
  if(parts.length===1)return whole;
  const fraction=parts[1].split(' ');let scale=1;
  if(fraction[fraction.length-1] in scales)scale=scales[fraction.pop()!];
  if(!fraction.length||fraction.some(w=>!(w in digits)))return null;
  return (whole+Number('0.'+fraction.map(w=>digits[w]).join('')))*scale;
}

const decimal=(n:number)=>String(n).replace('.',',');
const two=(n:number)=>String(n).padStart(2,'0');

function code(value:string):string|null {
  const tokens=value.trim().split(/[ \t]+/),result:string[]=[];let letter=false,digit=false,separator=false;
  for(let i=0;i<tokens.length;){
    const lower=space(tokens[i]),next=space(tokens[i+1]||'');
    if(lower==='gạch'&&(next==='ngang'||next==='dưới')){
      if(!result.length||/[-_.]$/.test(result[result.length-1]))return null;
      result.push(next==='ngang'?'-':'_');separator=true;i+=2;continue;
    }
    if(lower==='chấm'){
      if(!result.length||/[-_.]$/.test(result[result.length-1]))return null;
      result.push('.');separator=true;i++;continue;
    }
    if(lower==='chữ'&&(next==='hoa'||next==='thường')&&/^[a-z]$/i.test(tokens[i+2]||'')){
      result.push(next==='hoa'?tokens[i+2].toUpperCase():tokens[i+2].toLowerCase());letter=true;i+=3;continue;
    }
    if(lower==='số'){i++;if(!(space(tokens[i]||'') in digits)&&!/^\d+$/.test(tokens[i]||''))return null;continue;}
    if(/^\d+$/.test(tokens[i])){result.push(tokens[i]);digit=true;i++;continue;}
    if(lower in digits&&['không','một','hai','ba','bốn','năm','sáu','bảy','tám','chín'].includes(lower)){
      result.push(String(digits[lower]));digit=true;i++;continue;
    }
    if(i===0&&/^[a-z]$/i.test(tokens[i])){result.push(tokens[i]);letter=true;i++;continue;}
    return null;
  }
  return letter&&digit&&separator&&!/[-_.]$/.test(result[result.length-1]||'')&&result.join('').length<=64?result.join(''):null;
}

export function formatTranscript(original:string,completed=true,sourceParts?:readonly string[]):FormattedTranscript {
  const changes:TranscriptFormatChange[]=[],occupied:Array<[number,number]>=[];
  if(!completed||original.length>50000)return {original,text:original,changes,version:'vi-display.v1'};
  if(sourceParts){
    if(sourceParts.length>128||sourceParts.join(' ')!==original)return {original,text:original,changes,version:'vi-display.v1'};
    let offset=0;const displays=sourceParts.map(part=>{
      const display=formatTranscript(part,true);
      changes.push(...display.changes.map(c=>({...c,start:c.start+offset,end:c.end+offset})));
      offset+=part.length+1;return display.text;
    });
    return {original,text:displays.join(' '),changes,version:'vi-display.v1'};
  }
  const protect=/```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|⟦[^⟧]*⟧\{[^}]*\}/gu;
  for(const m of original.matchAll(protect))occupied.push([m.index!,m.index!+m[0].length]);
  function apply(regex:RegExp,kind:TranscriptFormatKind,replace:(m:RegExpMatchArray)=>string|null){
    for(const match of original.matchAll(regex)){
      const start=match.index!,end=start+match[0].length;
      if(occupied.some(([a,b])=>start<b&&end>a))continue;
      occupied.push([start,end]); // Rejected structured spans must not be partially normalized later.
      const replacement=replace(match);
      if(replacement!==null&&replacement!==match[0])changes.push({start,end,original:match[0],replacement,kind});
    }
  }
  apply(pattern(`(ngày[ \\t]+)(${num})[ \\t]+tháng[ \\t]+(${num})(?:[ \\t]+(nay|sau|trước))?`),'date',m=>{
    const tail=new RegExp('^('+monthNumber+')(?: năm (.+))?$','iu').exec(space(m[3])+(m[4]?' '+space(m[4]):''));
    if(!tail)return null;
    const day=number(m[2]),month=number(tail[1]),year=tail[2]?number(tail[2]):null;
    if(day===null||month===null||![day,month].every(Number.isInteger)||month<1||month>12||day<1)return null;
    if(tail[2]&&(year===null||!Number.isInteger(year)||year<1000||year>9999))return null;
    const days=new Date(Date.UTC(year??2000,month,0)).getUTCDate();
    if(day>days)return null;
    return m[1]+two(day)+'/'+two(month)+(year!==null?'/'+year:'');
  });
  apply(pattern(`((?:lúc|vào[ \\t]+lúc)[ \\t]+)(${num})[ \\t]+giờ(?:[ \\t]+(rưỡi|(?:kém|hơn|chừng)[ \\t]+${num}|${num})(?:[ \\t]+phút)?)?(?:[ \\t]+(sáng|chiều|tối|trưa))?`),'time',m=>{
    let hour=number(m[2]);const minute=m[3]?(space(m[3])==='rưỡi'?30:number(m[3])):0,period=space(m[4]||'');
    if(hour===null||minute===null||![hour,minute].every(Number.isInteger)||hour>23||minute>59)return null;
    if(period){if(hour<1||hour>12)return null;if(period==='sáng')hour%=12;else if(hour<12)hour+=12;}
    return m[1]+two(hour)+':'+two(minute);
  });
  const digitWord='không|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|\\d';
  apply(pattern(`((?:số[ \\t]+điện[ \\t]+thoại|điện[ \\t]+thoại|số[ \\t]+di[ \\t]+động)[ \\t]*(?::|là)?[ \\t]*)((?:cộng[ \\t]+|\\+)?(?:${digitWord})(?:[ \\t]+(?:${digitWord})){1,20})`),'phone',m=>{
    const international=/^(cộng|\+)/i.test(m[2]),tokens=space(m[2]).replace(/^(cộng[ \t]+|\+)/,'').split(' ');
    const value=tokens.map(t=>t in digits?digits[t]:t).join('');
    if(!/^\d+$/.test(value)||(international?!/^[1-9]\d{7,14}$/.test(value):!/^0\d{8,10}$/.test(value)))return null;
    return m[1]+(international?'+':'')+value;
  });
  apply(pattern(`((?:mã[ \\t]+kỹ[ \\t]+thuật|mã)[ \\t]+(?:là[ \\t]+)?)([\\p{L}\\p{N}]+(?:[ \\t]+[\\p{L}\\p{N}]+){1,32})`),'technical',m=>{
    const result=code(m[2]);return result===null?null:m[1]+result;
  });
  apply(pattern(`((?:PostgreSQL|Python|Node\\.js|CUDA|GPT|API)[ \\t]+phiên[ \\t]+bản[ \\t]+)(${num}(?:[ \\t]+chấm[ \\t]+${num}){0,3})`),'technical',m=>{
    const values=space(m[2]).split(' chấm ').map(v=>/^\d+$/.test(v)?v:number(v));
    if(values.some(v=>v===null||!Number.isInteger(Number(v))||Number(v)>9999))return null;
    return m[1]+values.join('.');
  });
  apply(pattern(`((?:âm|dương)[ \\t]+)?(${num})[ \\t]*(phần[ \\t]+trăm|%|đồng|VND|USD|đô[ \\t]+la|đứa|người|cái|chiếc|lần|cấp)`),'number',m=>{
    const value=number(m[2]);if(value===null)return null;
    const sign=m[1]?(space(m[1])==='âm'?'-':'+'):'',unit=space(m[3]);
    if(unit==='phần trăm'||unit==='%')return sign+decimal(value)+'%';
    const tokens=space(m[2]).split(' '),scale=tokens[tokens.length-1],factor=scales[scale]||1;
    return sign+decimal(value/factor)+(factor>1?' '+scale:'')+' '+m[3];
  });
  changes.sort((a,b)=>a.start-b.start);
  let text='',cursor=0;
  for(const c of changes){text+=original.slice(cursor,c.start)+c.replacement;cursor=c.end;}
  return {original,text:text+original.slice(cursor),changes,version:'vi-display.v1'};
}
