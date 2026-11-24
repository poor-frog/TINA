"""Select a pinned Fargate workspace task whose actual mounts match the current grants."""
from dataclasses import dataclass
import json
import re


@dataclass(frozen=True)
class WorkspaceTask:
    owner: str
    definition: str
    group: str
    image: str
    cpu: int
    memory: int
    mounts: dict[str, bool]

    @classmethod
    def load(cls, ecs, owner, spec):
        if not re.fullmatch(r'[1-9][0-9]*', owner):
            raise ValueError('Invalid pilot owner')
        arn, group = spec['definition'], spec['security_group']
        if not re.fullmatch(r'arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[^:]+:[0-9]+', arn) or not re.fullmatch(r'sg-[a-f0-9]+', group):
            raise ValueError('Workspace tasks require a pinned revision and a security group')
        task = ecs.describe_task_definition(taskDefinition=arn)['taskDefinition']
        containers = {c['name']: c for c in task['containerDefinitions']}
        if (set(containers) != {'worker', 'stream'} or task['networkMode'] != 'awsvpc'
                or 'FARGATE' not in task['requiresCompatibilities'] or not task.get('taskRoleArn')):
            raise ValueError('Workspace worker requires the private stream sidecar on Fargate')
        worker = containers['worker']
        image = worker['image']
        if (not re.search(r'@sha256:[0-9a-f]{64}$', image) or worker.get('secrets')
                or worker.get('user') != '1000:1000' or containers['stream'].get('mountPoints')
                or containers['stream']['image'] != image):
            raise ValueError('Invalid workspace worker isolation')
        for container in containers.values():
            declared = {x['name']:x['value'] for x in container.get('environment', [])}
            if declared.get('TINA_OWNER') != owner:
                raise ValueError('Task definition belongs to a different pilot subject')
        volumes = {v['name']: v.get('efsVolumeConfiguration', {}) for v in task['volumes']}
        mounts = {}
        home, system = '/workspaces/' + owner, '/workspaces/_system/' + owner
        for mount in worker.get('mountPoints', []):
            dest = mount['containerPath']
            efs = volumes[mount['sourceVolume']]
            auth = efs.get('authorizationConfig', {})
            if (dest in mounts or not dest.startswith('/workspaces/')
                    or not re.fullmatch(r'(?:/[A-Za-z0-9_-][A-Za-z0-9._-]*)+', dest)
                    or efs.get('transitEncryption') != 'ENABLED' or auth.get('iam') != 'ENABLED'
                    or not auth.get('accessPointId')):
                raise ValueError('Invalid workspace access point or mount path')
            if dest not in (home, system) and not re.fullmatch(r'/workspaces/[A-Za-z][A-Za-z0-9-]*', dest):
                raise ValueError('Unexpected additional workspace mount')
            mounts[dest] = not mount.get('readOnly', False)
        if not mounts.get(system) or home not in mounts:
            raise ValueError('Workspace and private continuity mounts are required')
        return cls(owner, arn, group, image, int(task['cpu']), int(task['memory']), mounts)


def parse_workspace_request(workload, env):
    owner = env.get('TINA_OWNER', '')
    trigger = env.get('TINA_UNIT_TRIGGER')
    if (not re.fullmatch(r'[1-9][0-9]*', owner)
            or env.get('TINA_UNIT_ID') != workload or env.get('TINA_UNIT_IN_TOPIC') != f'unit:{workload}:in'
            or env.get('TINA_UNIT_OUT_TOPIC') != f'unit:{workload}:out'
            or not re.fullmatch(r'[0-9a-f]{32}', env.get('TINA_WORKSPACE_ATTEMPT', ''))):
        raise ValueError('Workspace invocation binding mismatch')
    if trigger == 'message':
        session = env.get('TINA_CHAT_SESSION', '')
        if not re.fullmatch(r'[A-Za-z0-9._-]{1,90}', session) or workload != f'agent-{owner}-chat-{session}':
            raise ValueError('Invalid workspace chat session')
    elif trigger != 'scheduled' or not re.fullmatch('agent-' + re.escape(owner) + '-scheduled-[a-f0-9]{10}', workload):
        raise ValueError('Invalid workspace invocation trigger')
    grants = json.loads(env['TINA_MOUNTS'])
    if not isinstance(grants, list):
        raise ValueError('Expected workspace grants')
    mounts = {}
    for grant in grants:
        path = grant['path']
        if path in mounts or type(grant.get('write')) is not bool or grant.get('source'):
            raise ValueError('Invalid workspace grant')
        mounts[path] = grant['write']
    cwd = env.get('TINA_WORKSPACE_PATH', '')
    if cwd not in mounts:
        raise ValueError('Worker current directory is outside approved mounts')
    return owner, mounts, cwd


def select_workspace(tasks, workload, env):
    owner, mounts, _cwd = parse_workspace_request(workload, env)
    for task in tasks:
        if task.owner == owner and task.mounts == mounts:
            return task
    raise ValueError('No pinned workspace task matches the current grants')
