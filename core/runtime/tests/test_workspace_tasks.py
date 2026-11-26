import json

import pytest

from runtime_kernel.workspace_tasks import WorkspaceTask, select_workspace


def test_only_exact_pilot_subject_session_and_grants_can_use_the_definition():
    mounts = {'/workspaces/2': True, '/workspaces/_system/2': True, '/workspaces/wiki-team': False}
    task = WorkspaceTask('2', 'task', 'sg', 'image', 1024, 2048, mounts)
    workload = 'agent-2-chat-main'
    grants = [{'path':path, 'write':write} for path,write in mounts.items()]
    env = {'TINA_OWNER':'2', 'TINA_UNIT_TRIGGER':'message', 'TINA_CHAT_SESSION':'main',
           'TINA_UNIT_ID':workload, 'TINA_UNIT_IN_TOPIC':f'unit:{workload}:in',
           'TINA_UNIT_OUT_TOPIC':f'unit:{workload}:out', 'TINA_WORKSPACE_ATTEMPT':'a'*32,
           'TINA_MOUNTS':json.dumps(grants),'TINA_WORKSPACE_PATH':'/workspaces/2'}
    assert select_workspace([task],workload,env) == task
    for change in ({'TINA_OWNER':'5'}, {'TINA_CHAT_SESSION':'other'}, {'TINA_UNIT_OUT_TOPIC':'unit:agent-5-chat-main:out'},
                   {'TINA_MOUNTS':json.dumps(grants[:-1])},
                   {'TINA_MOUNTS':json.dumps(grants[:-1] + [grants[-1] | {'write': True}])},
                   {'TINA_WORKSPACE_PATH':'/workspaces/5'}):
        with pytest.raises(ValueError):
            select_workspace([task],workload,env|change)
