"""Actual Pipecat Flows text-only transitions over TINA's authorized model/tool API."""
import asyncio
from uuid import uuid4

from loguru import logger

logger.disable('pipecat')

from pipecat.flows import FlowManager, FlowsFunctionSchema
from pipecat.frames.frames import LLMContextFrame, LLMMessagesAppendFrame, LLMRunFrame, FunctionCallFromLLM
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.workers.runner import WorkerRunner
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start import ExternalUserTurnStartStrategy
from pipecat.turns.user_stop import ExternalUserTurnStopStrategy
from pipecat.services.llm_service import LLMService

NODES = {'title', 'assignee', 'due', 'review', 'decision_status', 'decision_evidence'}


class TinaTaskLLM(LLMService):
    """Inference stays behind TINA: selected provider credentials never enter this pipeline."""
    def __init__(self, agent, request, result):
        super().__init__(function_call_timeout_secs=30)
        self.agent, self.request, self.result = agent, request, result
        self.proposal = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            try:
                if self.proposal is not None:
                    raise RuntimeError('Task flow inference already dispatched')
                self.proposal = await self.agent(self.request, 'flow_plan')
                await self.run_function_calls([FunctionCallFromLLM(function_name='advance_draft',
                    tool_call_id=str(uuid4()), arguments={}, context=frame.context)])
            except Exception:
                if not self.result.done(): self.result.set_exception(RuntimeError('Task flow planning failed'))
        else:
            await self.push_frame(frame, direction)


async def run_task_flow(node, agent, request, kind='task'):
    allowed={'title','review','decision_status','decision_evidence'} if kind=='decision' else {'title','assignee','due','review'}
    if kind not in ('task','decision') or node not in allowed:
        raise ValueError('Unknown task flow node')
    result = asyncio.get_running_loop().create_future()
    model = TinaTaskLLM(agent, request, result)
    context = LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(
        user_turn_strategies=UserTurnStrategies(start=[ExternalUserTurnStartStrategy()],stop=[ExternalUserTurnStopStrategy()])))
    worker = PipelineWorker(Pipeline([context.user(),model,context.assistant()]),enable_rtvi=False)
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    manager = FlowManager(worker=worker,llm=model,context_aggregator=context)
    applied = None

    async def deliver(action, flow):
        if not result.done(): result.set_result(applied)

    async def advance(args, flow):
        nonlocal applied
        try:
            applied = await agent(request, 'flow_apply')
            if applied != model.proposal or applied.get('node') not in NODES:
                raise RuntimeError('Task flow proposal changed')
            flow.state['node'] = applied['node']
            return {'transition':'applied'}, {'name':applied['node'],'task_messages':[
                {'role':'developer','content':'Wait for the next confirmed spoken user turn.'}],
                'functions':[],'respond_immediately':False,'pre_actions':[{'type':'deliver'}]}
        except Exception:
            if not result.done(): result.set_exception(RuntimeError('Task flow transition failed'))
            raise RuntimeError('Task flow transition failed') from None

    manager.register_action('deliver',deliver)
    tool = FlowsFunctionSchema(name='advance_draft',description='Apply only the current TINA-approved task or decision draft transition.',
        properties={},required=[],handler=advance,cancel_on_interruption=True)
    running = asyncio.create_task(runner.run())
    try:
        await manager.initialize({'name':node,'task_messages':[{'role':'developer',
            'content':'Collect only the missing draft field. TINA validates input, decision evidence and all writes.'}],
            'functions':[tool],'respond_immediately':False})
        await worker.queue_frames([LLMMessagesAppendFrame(messages=[{'role':'user','content':request['body']['question']}]),LLMRunFrame()])
        return await asyncio.wait_for(result,90 if kind=='decision' else 40)
    finally:
        await worker.cancel()
        await running
