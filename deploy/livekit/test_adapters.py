import asyncio
import pytest
from livekit import rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.types import APIConnectOptions
from adapters import TinaLLM, VieNeuTTS, HttpAudioOutput
from rag import TOOLS


@pytest.mark.parametrize('tool_name', ['draft_task', 'draft_decision', 'search_approved_actions', 'calculate', 'search_shared_meetings','open_source'])
async def test_actual_agents_langgraph_calls_tina_tools_without_an_approval_tool(tool_name):
    operations=[]
    async def agent(request, operation, lookup=None):
        operations.append((operation,lookup))
        if operation=='plan':return {'tool_calls':[{'name':tool_name,'query':'Owner-reviewed proposal'}] if len(operations)==1 else []}
        assert lookup=={'name':tool_name,'query':'Owner-reviewed proposal'}
        return {'tool':tool_name,'source_count':0,'draft':{'title':lookup['query']}}
    async def answer(request):return {'text':'Em đã chuẩn bị bản nháp; chủ meeting xác nhận trong Terminal.','reason':'answered'}
    model=TinaLLM(answer,agent);model.request={'body':{},'speaker':None}
    session=AgentSession(llm=model,vad=None,turn_detection='manual',user_away_timeout=None)
    try:
        await session.start(Agent(instructions='Use authorized TINA tools.'))
        handle=session.generate_reply(user_input='Tạo bản nháp',chat_ctx=llm.ChatContext.empty())
        await asyncio.wait_for(handle.wait_for_playout(),5)
        assert handle.exception() is None and model.result['reason']=='answered'
        assert [op for op,_ in operations]==['plan','lookup','plan']
        assert not any(name.startswith(('approve','publish','confirm')) for name in TOOLS)
    finally:await session.aclose()


@pytest.mark.parametrize('buffered', [False, True])
async def test_stop_closes_the_upstream_pcm_iterator_and_clears_unplayed_audio(buffered):
    entered, closed = asyncio.Event(), asyncio.Event()
    class Speech:
        first = True
        def __aiter__(self): return self
        async def __anext__(self):
            if buffered and self.first:
                self.first=False
                return b'\x01\x00' * 2400
            entered.set()
            await asyncio.Event().wait()
        async def aclose(self): closed.set()
    model=VieNeuTTS(lambda _text:Speech())
    output=HttpAudioOutput()
    session=AgentSession(tts=model,vad=None,turn_detection='manual',user_away_timeout=None)
    session.output.audio=output
    try:
        await session.start(Agent(instructions='Use local TTS.'))
        handle=session.say('Synthetic private reply.',add_to_chat_ctx=False)
        await asyncio.wait_for(entered.wait(),2)
        if buffered:
            for _ in range(100):
                if not output.queue.empty(): break
                await asyncio.sleep(.01)
            assert not output.queue.empty()
        handle.interrupt()
        await asyncio.wait_for(closed.wait(),2)
        await asyncio.wait_for(handle.wait_for_playout(),2)
        assert output.queue.empty() and model.synthesis.failed
    finally: await session.aclose()


async def test_actual_agents_llm_session_calls_tina_once_and_preserves_metadata():
    calls=[]
    async def answer(request):
        calls.append(request)
        return {'text':'Lan phụ trách demo.','sources':[{'id':'s0'}],'reason':'answered'}
    model=TinaLLM(answer)
    model.request={'question':'Ai làm demo?','request_id':'synthetic'}
    session=AgentSession(llm=model,vad=None,turn_detection='manual',user_away_timeout=None)
    try:
        await session.start(Agent(instructions='Use the authorized TINA backend.'))
        handle=session.generate_reply(user_input='Ai làm demo?',chat_ctx=llm.ChatContext.empty())
        await asyncio.wait_for(handle.wait_for_playout(),5)
        assert handle.exception() is None
        assert len(calls)==1 and model.result['sources']==[{'id':'s0'}]
    finally: await session.aclose()


async def test_actual_agents_tts_emits_bounded_pcm_without_a_cloud_model():
    calls=[]
    async def speech(text):
        calls.append(text)
        yield b'\0\0' * 2400
    model=VieNeuTTS(speech)
    output=HttpAudioOutput()
    session=AgentSession(tts=model,vad=None,turn_detection='manual',user_away_timeout=None)
    session.output.audio=output
    try:
        await session.start(Agent(instructions='Use local TTS.'))
        handle=session.say('Dạ, em nghe.',add_to_chat_ctx=False)
        async def drain():
            data=bytearray()
            while not handle.done() or not output.queue.empty():
                try:data.extend(await asyncio.wait_for(output.queue.get(),.1))
                except TimeoutError:pass
            return data
        data=await asyncio.wait_for(drain(),5)
        assert handle.exception() is None and 4800 <= len(data) <= 5760 and len(calls)==1
        assert model.synthesis.complete
    finally: await session.aclose()
