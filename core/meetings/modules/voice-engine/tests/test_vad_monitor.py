import numpy as np
from tina_meeting_voice.vad_monitor import VadMonitor


def test_setup_makes_verified_shared_silero_readable_by_non_root_without_downloading(tmp_path,monkeypatch):
    import hashlib
    import sys
    from tina_meeting_voice import assets,bot,turn_assets
    model=tmp_path/'silero_vad.onnx';model.write_bytes(b'synthetic-model');model.chmod(0o600)
    monkeypatch.setattr(assets,'manifest',lambda:{'vad':{'sha256':hashlib.sha256(b'synthetic-model').hexdigest()}})
    monkeypatch.setattr(turn_assets,'install',lambda directory:None)
    monkeypatch.setattr(sys,'argv',['bot',str(tmp_path),'--setup','--vad-only'])
    bot.main()
    assert model.stat().st_mode&0o444==0o444


class Vad:
    def __init__(self): self.last_end_sample = None; self.active = False; self.ended = False
    def feed(self, samples): return self.active, self.ended


def test_vad_only_streams_are_isolated_and_report_source_speech_end_not_silence_tail():
    now, events, vads = [0.0], [], []
    def factory():
        value = Vad(); vads.append(value); return value
    engine = VadMonitor(None, events.append, lambda: now[0], factory)
    engine.feed(1, None, np.ones(320), 1000)
    engine.feed(2, None, np.ones(320), 1000)
    assert len(vads) == 2
    vads[0].active = True
    engine.feed(1, None, np.ones(320), 1020)
    vads[0].active = False; vads[0].ended = True; vads[0].last_end_sample = 400
    engine.feed(1, None, np.zeros(320), 1040)
    activity = [e for e in events if e.get('event') == 'activity' and e['channel'] == 1]
    assert activity[-1]['speech'] is False and activity[-1]['endMs'] == 1025
    engine.close()
    assert not engine.channels


def test_vad_only_waits_for_received_room_quiet_and_does_not_load_keyword_model():
    now, events, vads = [0.0], [], []
    def factory():
        value = Vad(); vads.append(value); return value
    engine = VadMonitor(None, events.append, lambda: now[0], factory)
    engine.control('THINKING')
    engine.feed(0, None, np.ones(320), 1000)
    assert len(vads) == 1 and engine.channels and engine.state == 'THINKING'
    engine.control('QUIET')
    for channel in range(32): engine.feed(channel, None, np.zeros(320), 1000)
    assert engine.state == 'QUIET'
    now[0] = .81; engine.feed(0, None, np.zeros(320), 1020)
    assert engine.state == 'LISTENING'


def test_endpoint_tracking_continues_during_quiet_without_early_wake_rearm():
    now, events, vads = [0.0], [], []
    def factory():
        value = Vad(); vads.append(value); return value
    engine = VadMonitor(None, events.append, lambda: now[0], factory)
    engine.control('QUIET')
    vads[0].active = True
    engine.feed(0, None, np.ones(320), 1000)
    assert engine.state == 'QUIET'
    assert events[-1]['event'] == 'activity' and events[-1]['speech'] is True
    now[0] = .3
    vads[0].active = False; vads[0].ended = True; vads[0].last_end_sample = 200
    engine.feed(0, None, np.zeros(320), 1020)
    assert engine.state == 'QUIET'
    assert events[-1]['speech'] is False and events[-1]['endMs'] == 1012.5
    now[0] = .81; vads[0].ended = False
    engine.feed(0, None, np.zeros(320), 1040)
    assert engine.state == 'LISTENING'
    engine.close()


def test_busy_vad_reports_endpoints_for_explicit_interruption_without_rearming_wake():
    events=[];vad=Vad();engine=VadMonitor(None,events.append,lambda:1,lambda:vad)
    engine.control('SPEAKING');vad.active=True
    engine.feed(2,'p',np.ones(320),1000)
    assert events[-1]['event']=='activity' and events[-1]['speech'] is True
    vad.active=False;vad.ended=True;vad.last_end_sample=320
    engine.feed(2,'p',np.zeros(320),1020)
    assert events[-1]['endMs']==1020 and engine.state=='SPEAKING'
    assert not any(e.get('state')=='LISTENING' for e in events[1:])
