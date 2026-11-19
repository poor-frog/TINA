"""Participant boundary: own API key only; capture continues while room grant is pending."""
from concurrent.futures import ThreadPoolExecutor
import os
from queue import Queue
import threading
import time
from uuid import UUID, uuid4

import httpx
import numpy as np

from tina_meeting_voice.capture import QuestionCapture, SileroVad
from tina_meeting_voice.wakeword import SherpaKws, WakeDetector


class RoomClient:
    def __init__(self, url, key, *, http=None):
        parsed = httpx.URL(url)
        if (not key or parsed.userinfo or parsed.query or parsed.scheme not in ('http', 'https')
                or parsed.scheme == 'http' and parsed.host not in ('localhost', '127.0.0.1', '::1')):
            raise ValueError("Use your own private API key and HTTPS (HTTP only on loopback)")
        self.url = url.rstrip('/')
        self.http = http or httpx.Client(headers={'X-API-Key': key}, timeout=8,
                                        follow_redirects=False, trust_env=False)
        self.http.headers['X-API-Key'] = key
        self.epoch = None

    def room(self):
        response = self.http.get(self.url + '/room', timeout=1)
        response.raise_for_status()
        status = response.json()
        if (set(status) != {'epoch', 'revision', 'busy'} or type(status['busy']) is not bool
                or type(status['revision']) is not int or not 0 <= status['revision'] < 10**15
                or str(UUID(status['epoch'])) != status['epoch']):
            raise ValueError('Invalid room status')
        return status

    def call(self, method, identifier, suffix='', **kwargs):
        kwargs['headers'] = dict(kwargs.get('headers', {})) | {'X-Tina-Speech-Epoch': self.epoch}
        response = self.http.request(method, self.url + '/turns/' + identifier + suffix, **kwargs)
        response.raise_for_status()
        state = response.json()
        if state.get('request_id') != identifier:
            raise ValueError("Mismatched turn response")
        return state

    def reserve(self, identifier, revision):
        state = self.call('POST', identifier, headers={'X-Tina-Speech-Revision': str(revision)})
        if state['state'] != 'CAPTURING':
            raise ValueError("Turn grant is not fresh")
        return state

    def submit(self, identifier, audio, stopped, notify):
        self.call('PUT', identifier, '/audio', content=audio, headers={'Content-Type': 'audio/wav'})
        deadline = time.monotonic() + 330
        while time.monotonic() < deadline and not stopped.is_set():
            state = self.call('GET', identifier)
            notify(state['state'])
            if state['state'] in ('COMPLETED', 'FAILED', 'STOPPED', 'ERROR'):
                return state['state']
            stopped.wait(.2)
        if stopped.is_set():
            return 'STOPPED'
        raise TimeoutError("Turn status unavailable; dispatch remains disarmed")

    def cancel(self, identifier):
        return self.call('DELETE', identifier, timeout=15)


class RoomMonitor:
    """Independent bounded polling: a turn's HTTP worker may be waiting for playback."""
    def __init__(self, client):
        self.client = client
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.value, self.updated = client.room(), time.monotonic()
        client.epoch = self.value['epoch']
        self.thread = threading.Thread(target=self.run, name='tina-speech-room', daemon=True)
        self.thread.start()

    def run(self):
        while not self.stop.wait(.25):
            try: value = self.client.room()
            except Exception: value = None
            with self.lock:
                self.value, self.updated = value, time.monotonic()

    def snapshot(self):
        with self.lock:
            return self.value if time.monotonic() - self.updated <= 1 else None

    def close(self):
        self.stop.set()
        self.thread.join(timeout=1.5)


class SpeechSession:
    def __init__(self, directory, client, emit, *, detector=None, vad_factory=None, monitor=None):
        self.detector = detector or WakeDetector(SherpaKws(directory))
        self.vad_factory = vad_factory or (lambda: SileroVad(directory))
        self.client, self.emit = client, emit
        self.monitor = monitor or RoomMonitor(client)
        initial = self.monitor.snapshot()
        if initial is None:
            self.monitor.close()
            raise ValueError('Room status unavailable; participant remains disarmed')
        self.epoch = initial['epoch']
        self.revision = initial['revision']
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='tina-speech-http')
        self.messages = Queue(maxsize=8)
        self.stopped = threading.Event()
        self.state = 'BUSY' if initial['busy'] else 'ARMED'
        self.quiet_samples = 0
        self.identifier = None
        self.capture = None
        self.audio = None
        self.future = None
        self.emit({'event': 'turn', 'state': self.state})

    def transition(self, state):
        if self.state != state:
            self.state = state
            self.emit({'event': 'turn', 'state': state, 'request_id': self.identifier})

    def notice(self, state):
        # Only terminal/meaningful transitions need UI delivery, never one per poll.
        if state == 'SPEAKING' and self.messages.empty():
            self.messages.put_nowait(state)

    def fail(self):
        self.stopped.set()
        self.capture, self.audio = None, None
        self.detector.ring.clear()
        if self.identifier:
            # Best-effort Stop after the in-flight request; never replay audio/Speak.
            self.pool.submit(self.client.cancel, self.identifier)
        self.transition('ERROR')

    def tick(self):
        if self.state in ('ERROR', 'OFF'): return
        status = self.monitor.snapshot()
        if status is None or status['epoch'] != self.epoch:
            self.fail()
            return
        if self.state in ('ARMED', 'BUSY', 'QUIET'):
            if status['busy']:
                self.capture, self.audio = None, None
                self.detector.ring.clear()
                self.quiet_samples = 0
                self.transition('BUSY')
            elif self.state == 'BUSY' or status['revision'] != self.revision:
                self.quiet_samples = 0
                self.transition('QUIET')
        self.revision = status['revision']
        while not self.messages.empty():
            state = self.messages.get_nowait()
            if self.state in ('WAITING', 'SPEAKING'): self.transition(state)
        if not self.future or not self.future.done(): return
        future, self.future = self.future, None
        try:
            result = future.result()
            if self.state == 'CAPTURING':
                self.future = future  # keep the successful grant until bounded capture finishes
                if self.audio is not None:
                    self.transition('WAITING')
                    audio, self.audio = self.audio, None
                    self.future = self.pool.submit(self.client.submit, self.identifier, audio, self.stopped, self.notice)
                return
            if isinstance(result, dict): result = result.get('state')
            if result not in ('COMPLETED', 'FAILED', 'STOPPED'):
                self.fail()
            else:
                self.rearm()
        except httpx.HTTPStatusError as exc:
            self.capture, self.audio = None, None
            try: detail = exc.response.json().get('detail')
            except (ValueError, AttributeError): detail = None
            if (self.state == 'CAPTURING' and exc.response.status_code == 409
                    and detail == 'Room is busy or awaiting operator recovery'):
                self.identifier = None
                self.transition('BUSY')
            else:
                self.fail()
        except Exception:
            self.fail()

    def rearm(self):
        self.capture, self.audio = None, None
        self.detector.kws.reset()
        self.detector.ring.clear()
        self.detector.armed = True
        self.identifier = None
        self.quiet_samples = 0
        self.transition('QUIET')

    def feed(self, block):
        self.tick()
        if self.state == 'QUIET':
            self.quiet_samples = self.quiet_samples + len(block) if np.sqrt(np.mean(block ** 2)) < .01 else 0
            if self.quiet_samples >= 12800:
                self.detector.kws.reset()
                self.detector.ring.clear()
                self.detector.armed = True
                self.transition('ARMED')
            return None
        if self.state == 'ARMED':
            event = self.detector.feed(block)
            if event:
                try:
                    self.capture = QuestionCapture(event, self.vad_factory())
                except ValueError:
                    self.fail()
                    return
                self.identifier = str(uuid4())
                self.transition('CAPTURING')
                self.future = self.pool.submit(self.client.reserve, self.identifier, self.revision)
        elif self.state == 'CAPTURING' and self.audio is None:
            try:
                self.audio = self.capture.feed(block)
            except ValueError:
                # Cancel the grant after any in-flight reservation, never submit a partial question.
                self.future = self.pool.submit(self.client.cancel, self.identifier)
                self.transition('WAITING')
        self.tick()
        return None

    def close(self):
        if self.state == 'OFF': return
        self.stopped.set()
        self.monitor.close()
        self.detector.close()
        self.capture, self.audio = None, None
        identifier = self.identifier
        def cleanup():
            # Ordered after reserve/upload, so a late grant cannot survive local Stop.
            try:
                if identifier: self.client.cancel(identifier)
            finally:
                self.client.http.close()
        self.pool.submit(cleanup)
        self.pool.shutdown(wait=False, cancel_futures=False)
        self.transition('OFF')


def configured_client():
    return RoomClient(os.environ.get('TINA_SPEECH_COORDINATOR_URL', 'http://127.0.0.1:18006'),
                      os.environ.get('TINA_SPEECH_USER_KEY', ''))
