"""Ephemeral speech.v1 playback receipts; Redis CAS keeps terminal states immutable."""
import hashlib
import json
import time
import logging

from redis.exceptions import WatchError

TERMINAL = {"completed", "failed", "stopped"}


class SpeechConflict(Exception):
    pass


class PlaybackStore:
    def __init__(self, redis, on_voice_reply=None):
        self.redis = redis
        self.on_voice_reply = on_voice_reply

    async def persist(self, record):
        if self.on_voice_reply and record.get('voice_reply'):
            try:
                await self.on_voice_reply(record['meeting_id'], record['session_uid'], record['voice_reply'])
            except Exception:
                if record['state'] != 'stopped': raise
                # Stop already committed in Redis; receipt retries can repair history after DB recovery.
                logging.getLogger(__name__).warning('Stopped voice reply history persistence deferred')

    @staticmethod
    def key(meeting_id, command_id):
        return f"speech:playback:{meeting_id}:{command_id}"

    async def get(self, meeting_id, command_id):
        value = await self.redis.get(self.key(meeting_id, command_id))
        return json.loads(value) if value else None

    async def retire_previous_sessions(self, meeting_id, retired_sessions):
        active = await self.redis.get(f"speech:active:{meeting_id}")
        if isinstance(active, bytes): active = active.decode()
        record = await self.get(meeting_id, active) if active else None
        if record and record['session_uid'] in retired_sessions and record['state'] not in TERMINAL:
            # report uses CAS and deletes active ownership only if it still belongs to this command.
            await self.report(meeting_id, active, record['session_uid'], 'stopped')

    async def update(self, meeting_id, command_id, change, *, receipt=False, persist=True):
        key, active_key = self.key(meeting_id, command_id), f"speech:active:{meeting_id}"
        for _ in range(4):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(key, active_key)
                    raw, active = await pipe.get(key), await pipe.get(active_key)
                    active = active.decode() if isinstance(active, bytes) else active
                    current = json.loads(raw) if raw else None
                    result, write = change(current, active)
                    if not write:
                        await pipe.unwatch()
                        if persist: await self.persist(result)
                        return (result, False) if receipt else result
                    if result.get('voice_reply'):
                        now = int(time.time() * 1000)
                        reply = result['voice_reply'] | {'state': result['state'], 'updated_at_ms': now}
                        if result['state'] == 'started': reply.setdefault('started_at_ms', now)
                        if result['state'] in TERMINAL: reply['ended_at_ms'] = now
                        result = result | {'voice_reply': reply}
                    pipe.multi()
                    pipe.set(key, json.dumps(result), ex=600)
                    if result["state"] not in TERMINAL:
                        pipe.set(active_key, command_id, ex=200)
                    elif active == command_id:
                        pipe.delete(active_key)
                    await pipe.execute()
                    if persist: await self.persist(result)
                    return (result, True) if receipt else result
            except WatchError:
                continue
        raise SpeechConflict("Speech state changed concurrently")

    async def begin(self, meeting_id, command_id, session_uid, text, voice, *, reply=None):
        fingerprint = hashlib.sha256(json.dumps([text, voice]).encode()).hexdigest()
        def change(current, active):
            if current:
                if current["fingerprint"] != fingerprint or current["session_uid"] != session_uid:
                    raise SpeechConflict("Command ID already used for another request")
                return current, False
            if active and active != command_id:
                raise SpeechConflict("Another speech command is active")
            return {"command_id": command_id, "meeting_id": meeting_id, "session_uid": session_uid,
                    "fingerprint": fingerprint, "state": "queued", **({'voice_reply': reply} if reply else {})}, True
        return await self.update(meeting_id, command_id, change, receipt=True)

    async def report(self, meeting_id, command_id, session_uid, state, *, played_text=None):
        def change(current, active):
            if not current or current["session_uid"] != session_uid:
                raise SpeechConflict("Unknown speech command or bot session")
            if current["state"] in TERMINAL:
                return current, False
            if state == "completed" and current["state"] != "started":
                raise SpeechConflict("Playback must start before it can complete")
            if state == "started" and current.get("cancel_requested"):
                raise SpeechConflict("Speech cancellation is pending")
            if played_text is not None:
                reply = current.get('voice_reply')
                normalize = lambda text: ' '.join(text.split())
                value = normalize(played_text)
                if (not reply or current['state'] != 'started'
                        or not normalize(reply['text']).startswith(value)
                        or not value.startswith(normalize(reply.get('played_text') or ''))):
                    raise SpeechConflict('Invalid or regressing played text')
                current = current | {'voice_reply': reply | {'played_text': value}}
            return current | {"state": state}, True
        return await self.update(meeting_id, command_id, change)

    async def cancel(self, meeting_id, command_id, session_uid):
        def change(current, active):
            if not current:
                if active and active != command_id:
                    raise SpeechConflict("Another speech command is active")
                return {"command_id": command_id, "meeting_id": meeting_id, "session_uid": session_uid,
                        "fingerprint": None, "state": "queued", "cancel_requested": True}, True
            if current["state"] in TERMINAL:
                return current, False
            return current | {"cancel_requested": True}, True
        # Cancellation is a playback fence, not a new history state; the stopped receipt persists it.
        return await self.update(meeting_id, command_id, change, persist=False)

    @staticmethod
    def public(record):
        return {key: record[key] for key in ("command_id", "meeting_id", "state")}
