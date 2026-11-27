import asyncio

import pytest

from task_flow import run_task_flow


def proposal(action='update',node='assignee'):
    return {'action':action,'node':node,'state':{'title':'demo'},'text':'Bạn muốn ghi ai phụ trách?'}


@pytest.mark.parametrize('action',['update','pause','service_error'])
async def test_real_pipecat_manager_executes_only_the_authorized_transition(action):
    calls=[];expected=proposal(action=action)
    async def agent(request,operation):
        calls.append(operation)
        return expected
    value=await run_task_flow('title',agent,{'body':{'question':'Tạo task demo'}})
    assert value==expected and calls==['flow_plan','flow_apply']


async def test_flow_cancellation_stops_before_apply_and_cleans_up_the_pipeline():
    entered=asyncio.Event();calls=[]
    async def agent(request,operation):
        calls.append(operation);entered.set();await asyncio.Event().wait()
    running=asyncio.create_task(run_task_flow('title',agent,{'body':{'question':'Tạo task demo'}}))
    await asyncio.wait_for(entered.wait(),3)
    running.cancel()
    with pytest.raises(asyncio.CancelledError): await asyncio.wait_for(running,3)
    assert calls==['flow_plan']


async def test_flow_rejects_changed_core_proposal_and_unknown_node():
    async def agent(request,operation):
        return proposal(node='due' if operation=='flow_apply' else 'assignee')
    with pytest.raises(RuntimeError):
        await asyncio.wait_for(run_task_flow('title',agent,{'body':{'question':'Tạo task demo'}}),3)
    with pytest.raises(ValueError):
        await run_task_flow('publish_task',agent,{'body':{'question':'Tạo task demo'}})


@pytest.mark.parametrize('node',['title','decision_status','decision_evidence','review'])
async def test_decision_nodes_use_the_same_real_pipecat_manager(node):
    expected={'action':'update','node':'decision_evidence','state':{'kind':'decision','title':'dùng PostgreSQL'},
        'text':'Bạn chỉ giúp đoạn xác nhận nhé.'}
    calls=[]
    async def agent(request,operation):calls.append(operation);return expected
    assert await run_task_flow(node,agent,{'body':{'question':'Ghi quyết định dùng PostgreSQL'}},kind='decision')==expected
    assert calls==['flow_plan','flow_apply']
    with pytest.raises(ValueError):await run_task_flow('assignee',agent,{},kind='decision')


async def test_task_flow_teardown_is_bounded_when_worker_cancel_hangs(monkeypatch):
    import task_flow
    monkeypatch.setattr(task_flow, 'TEARDOWN_TIMEOUT', 0.05)
    async def stuck_cancel(self):
        await asyncio.Event().wait()
    monkeypatch.setattr(task_flow.PipelineWorker, 'cancel', stuck_cancel)
    expected = proposal()
    async def agent(request, operation):
        return expected
    value = await asyncio.wait_for(
        run_task_flow('title', agent, {'body': {'question': 'Tạo task demo'}}),
        timeout=2.0,
    )
    assert value == expected
