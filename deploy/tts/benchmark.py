"""Uncached CPU TTS/queue benchmark; simulate 150/300 ms playout without opening a microphone."""
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import re
import threading
import time

from engine import Engine
from server import SpeechServer

TEXTS=(
    'TINA đang kiểm tra tài liệu dự án. Lan phụ trách bản demo vào thứ sáu.',
    'Nhóm backend cần hoàn thành phần đăng nhập, kiểm thử quyền truy cập và cập nhật tài liệu trước buổi trình bày tiếp theo.',
    'Cuộc họp đã thống nhất ba việc: kiểm tra dữ liệu, hoàn thiện bản thử nghiệm và xác nhận người phụ trách. Những điểm chưa có nguồn sẽ được ghi lại để kiểm tra sau.',
)


def simulated_playout(events,total,buffer_ms):
    threshold=48000*buffer_ms/1000
    start=next((at for at,count in events if count>=threshold),events[-1][0])
    previous=0;max_gap=0
    for at,count in events:
        if at>=start:max_gap=max(max_gap,at-start-previous/48000*1000)
        previous=count
    return {'buffer_ms':buffer_ms,'ready_ms':round(start,1),'max_potential_starvation_ms':round(max(0,max_gap),1)}


def main():
    engine=Engine(Path('/models'))
    engine.synthesize('Đây là câu làm nóng bộ tổng hợp trước khi đo hiệu năng.')
    token='synthetic-benchmark-'+('x'*40)
    server=SpeechServer(('127.0.0.1',0),engine,token)
    serving=threading.Thread(target=server.serve_forever,daemon=True);serving.start()
    def request(text):
        connection=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=90)
        started=time.perf_counter();events=[];size=0
        try:
            connection.request('POST','/v1/audio/speech',json.dumps({'input':text,'voice':'auto'}),headers={'X-API-Key':token,'Content-Type':'application/json'})
            response=connection.getresponse();assert response.status==200
            while chunk:=response.read1(4096):
                size+=len(chunk);events.append(((time.perf_counter()-started)*1000,size))
            elapsed=(time.perf_counter()-started)*1000;assert size>0 and not size%2
            native=re.search(r'tts_first_audio;dur=([\d.]+)',response.getheader('Server-Timing',''))
            return {'characters':len(text),'audio_seconds':round(size/48000,3),'first_pcm_ms':round(events[0][0],1),
                'total_ms':round(elapsed,1),'native_first_audio_ms':float(native[1]) if native else None,
                'playout':[simulated_playout(events,size,ms) for ms in (150,300)]}
        finally:connection.close()
    try:
        baseline=request(TEXTS[0])
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:parallel=list(pool.map(request,TEXTS))
        print(json.dumps({'model':'v3-turbo-onnx-fp32','voice':'Trúc Ly','threads':int(os.environ.get('TINA_TTS_THREADS','2')),
            'single':baseline,'three_concurrent':parallel,'microphone_playback':False},ensure_ascii=False))
    finally:server.shutdown();server.server_close();serving.join(2)


if __name__=='__main__':main()
