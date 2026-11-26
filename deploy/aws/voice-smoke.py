"""Run from a separate staging Fargate task with the LiveKit Agent image."""

import asyncio
from array import array
from os import environ
from time import monotonic
from uuid import uuid4

import httpx
from livekit import api, rtc

SAMPLE_RATE = 24000
FRAME_SAMPLES = SAMPLE_RATE // 50


async def check_media(pcm):
    name = f'tina-staging-smoke-{uuid4()}'
    listener, speaker = rtc.Room(), rtc.Room()
    received = asyncio.Event()
    readers = set()

    async def listen(track):
        stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)
        try:
            async for event in stream:
                if max(map(abs, event.frame.data), default=0) > 128:
                    received.set()
                    return
        finally:
            await stream.aclose()

    @listener.on('track_subscribed')
    def subscribed(track, *_):
        reader = asyncio.create_task(listen(track))
        readers.add(reader)

    def token(identity):
        return api.AccessToken().with_identity(identity).with_grants(
            api.VideoGrants(room_join=True, room=name)).to_jwt()

    try:
        url = environ['LIVEKIT_URL']
        await listener.connect(url, token('listener'))
        await speaker.connect(url, token('speaker'))
        source = rtc.AudioSource(SAMPLE_RATE, 1)
        track = rtc.LocalAudioTrack.create_audio_track('vieneu-smoke', source)
        await speaker.local_participant.publish_track(track)
        frame_bytes = FRAME_SAMPLES * 2
        for offset in range(0, len(pcm), frame_bytes):
            data = pcm[offset:offset + frame_bytes].ljust(frame_bytes, b'\0')
            await source.capture_frame(rtc.AudioFrame(data, SAMPLE_RATE, 1, FRAME_SAMPLES))
        await asyncio.wait_for(received.wait(), timeout=10)
        await source.wait_for_playout()
    finally:
        await asyncio.gather(speaker.disconnect(), listener.disconnect(), return_exceptions=True)
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        async with api.LiveKitAPI() as livekit:
            await livekit.room.delete_room(api.DeleteRoomRequest(room=name))


async def main():
    tts = environ['TTS_SERVICE_URL']
    agent = environ['LIVEKIT_AGENT_URL']
    async with httpx.AsyncClient(timeout=25) as client:
        assert (await client.get(f'{tts}/ready')).status_code == 401
        headers = {'X-API-Key': environ['TTS_API_TOKEN']}
        status = (await client.get(f'{tts}/ready', headers=headers)).raise_for_status().json()
        assert status['sample_rate'] == SAMPLE_RATE and status['profiles_supported']
        status = (await client.get(f'{agent}/ready')).raise_for_status().json()
        assert status['tts_ready'] and status['audio_bridge_ready']
        start = monotonic()
        speech = await client.post(f'{tts}/v1/audio/speech', headers=headers, json={
            'input': 'Xin chào, đây là bản kiểm tra giọng nói tiếng Việt của TINA.',
            'response_format': 'pcm',
        })
        pcm = speech.raise_for_status().content
        elapsed = monotonic() - start
        assert len(pcm) >= SAMPLE_RATE and max(map(abs, array('h', pcm))) > 128
    await asyncio.wait_for(check_media(pcm), timeout=35)
    print(f'Voice smoke passed: {len(pcm) / (2 * SAMPLE_RATE):.2f} s of Vietnamese PCM '
          f'in {elapsed:.2f} s, received over LiveKit WebRTC')


if __name__ == '__main__':
    asyncio.run(main())
