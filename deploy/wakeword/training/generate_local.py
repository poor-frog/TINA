"""Run inside the existing pinned TTS image; generate isolated local training speech."""
import argparse
import hashlib
import json
import os
import random
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly
from engine import Engine

CONFUSABLES = [
    'tin à', 'tin anh ơi', 'tinh anh', 'tính năng', 'tin nhắn', 'tìm ra', 'đi ra',
    'tí nữa', 'anh ơi', 'chị ơi', 'ê anh', 'này bạn', 'hey team', 'tiền à', 'tin tức',
    'đây nè', 'thiên hà', 'thì nào', 'thiên nga', 'tiến à', 'tiên ơi', 'tính ra',
    'tin này', 'tí nào', 'tìm ai', 'tin vui', 'khi nào', 'thế nào', 'tiền nhà', 'tên là',
    'thì ra', 'tính nhẩm', 'kỳ na', 'thiên nhiên', 'thì anh', 'tin mới', 'hi team',
    'hey bạn', 'ê chị', 'đây anh ơi', 'đi nào', 'đi nè', 'tìm em',
]
SPEECH = [
    'Bạn gửi giúp mình bản kế hoạch mới nhất nhé.',
    'Deadline bản demo chuyển sang thứ Hai tuần sau.',
    'Nhóm kỹ thuật cần kiểm tra lại dịch vụ đăng nhập.',
    'Mình chưa đồng ý phương án này, hãy thảo luận thêm.',
    'API hiện đang trả lỗi do token hết hạn.',
    'Chúng ta sẽ triển khai lên staging trước khi lên production.',
    'Chi phí dự kiến là hai phẩy năm triệu đồng.',
    'Bạn có thể giải thích lại yêu cầu của khách hàng không?',
    'Phần này cần thêm unit test và kiểm thử tích hợp.',
    'Hôm nay trời mưa, đường đi có hơi đông.',
    'Bản ghi cuộc họp phải giữ đúng tên và số liệu.',
    'Chị Lan phụ trách demo, anh Minh hỗ trợ kiểm thử.',
    'Dạ, em nghe. Bạn cần em hỗ trợ việc gì?',
    'Tôi chưa có đủ thông tin để trả lời câu hỏi đó.',
    'Bạn đang hỏi bản demo hay bản chính thức?',
    'The deployment is ready for the integration test.',
    'Could you please review the pull request before lunch?',
    'We need to check the meeting audio and microphone.',
    'The next sprint starts on Monday.',
    'Please mute your microphone while the other person is speaking.',
    'Mọi người đã nhìn thấy màn hình chia sẻ chưa?',
    'Không, mình chưa chốt ngày bàn giao cuối cùng.',
    'Hãy mở tài liệu thiết kế và xem phần bảo mật.',
    'Đây là đề xuất, chưa phải quyết định của nhóm.',
    'Mình xin phép tạm dừng ở đây để kiểm tra thêm.',
]


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--recipe', required=True)
    args = parser.parse_args()
    root = Path(args.output); root.mkdir(parents=True, exist_ok=True)
    recipe = json.loads(Path(args.recipe).read_text())
    engine = Engine(Path('/models'))
    # Presets, not aliases: embeddings are deduplicated before assigning disjoint split voices.
    import vieneu
    data = json.loads((Path(vieneu.__file__).parent / 'assets/voices_v3_turbo.json').read_text())['presets']
    by_embedding = {}
    for name, row in data.items():
        key = hashlib.sha256(json.dumps(row['speaker_emb']).encode()).hexdigest()
        by_embedding.setdefault(key, name)
    voices = list(by_embedding.values()); random.Random(7919).shuffle(voices)
    if len(voices) < 12: raise RuntimeError('Too few independent preset voices')
    held = max(3, len(voices) // 6)
    splits = {'train': voices[:-2*held], 'validation': voices[-2*held:-held], 'test': voices[-held:]}
    (root / 'voice_splits.json').write_text(json.dumps(splits, ensure_ascii=False, indent=2)+'\n')
    emit(event='generator_ready', voices={k:len(v) for k,v in splits.items()}, tts='vieneu-3.8.3-v3turbo-onnx-cpu')
    started = time.monotonic()
    def generate(group, split, category, count, texts):
        directory=root/'clips'/group/split/category;directory.mkdir(parents=True,exist_ok=True)
        rows=[]
        for index in range(count):
            voice=splits[split][index % len(splits[split])]
            text=texts[index % len(texts)]
            target=directory/f'{index:05d}.wav';meta=target.with_suffix('.json')
            if target.exists() and meta.exists():
                existing=json.loads(meta.read_text())
                if (existing['voice']==voice and existing['text']==text
                        and hashlib.sha256(target.read_bytes()).hexdigest()==existing['sha256']):
                    rows.append(existing);continue
            np.random.seed(1009*index + {'train':1,'validation':2,'test':3}[split])
            for attempt in range(4):
                audio=np.asarray(engine.tts.infer(text, voice=voice, apply_watermark=False),dtype=np.float32)
                if audio.ndim!=1 or not np.isfinite(audio).all():raise ValueError('Invalid TTS waveform')
                if engine.tts.sample_rate!=16000:
                    from math import gcd
                    divisor=gcd(engine.tts.sample_rate,16000)
                    audio=resample_poly(audio,16000//divisor,engine.tts.sample_rate//divisor).astype(np.float32)
                if .15*16000 <= len(audio) <= (4 if category=='positive' else 15)*16000 and np.max(np.abs(audio))>.003:break
            else:raise RuntimeError(f'Invalid generated clip {group}/{split}/{category}/{index}')
            # Whole-utterance energy spans; these are synthetic alignment estimates, not human labels.
            frame=160; padded=np.pad(audio,(0,(-len(audio))%frame))
            rms=np.sqrt(np.mean(padded.reshape(-1,frame)**2,axis=1))
            active=np.flatnonzero(rms>=max(.002,float(rms.max())*.08))
            if not len(active):raise RuntimeError('No speech in generated clip')
            onset=max(0,int(active[0])*frame);offset=min(len(audio),int(active[-1]+1)*frame)
            lead=4000;tail=9600
            audio=np.pad(audio,(lead,tail))
            sf.write(target,audio,16000,subtype='PCM_16')
            row={'path':str(target.relative_to(root)),'group':group,'split':split,'category':category,
                 'voice':voice,'text':text,'onset_s':(onset+lead)/16000,'offset_s':(offset+lead)/16000,
                 'samples':len(audio),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),
                 'alignment':'synthetic_energy_10ms'}
            meta.write_text(json.dumps(row,ensure_ascii=False)+'\n');rows.append(row)
            if (index+1)%25==0:emit(event='generated',group=group,split=split,category=category,done=index+1,total=count,elapsed_s=round(time.monotonic()-started,1))
        return rows
    common={}
    for split,counts in recipe['counts'].items():
        common[split]=generate('shared',split,'adversarial',counts['adversarial'],CONFUSABLES)+generate('shared',split,'speech',counts['speech'],SPEECH)
    for phrase in recipe['phrases']:
        manifest=[]
        for split,counts in recipe['counts'].items():
            manifest.extend(common[split]);manifest.extend(generate(phrase['name'],split,'positive',counts['positive'],phrase['spoken']))
        ready=root/(phrase['name']+'.manifest.json')
        temp=ready.with_suffix('.tmp');temp.write_text(json.dumps(manifest,ensure_ascii=False)+'\n');temp.replace(ready)
        emit(event='phrase_data_ready',name=phrase['name'],rows=len(manifest))
    emit(event='generation_complete',elapsed_s=round(time.monotonic()-started,1))


if __name__=='__main__':main()
