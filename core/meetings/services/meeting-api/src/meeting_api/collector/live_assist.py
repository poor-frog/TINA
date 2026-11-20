"""Two-stage meeting state. Pure transitions; caller holds the meeting lock, never an LLM.

Internal state is deliberately not an HTTP projection. Jobs and evidence revisions stay private.
"""
from __future__ import annotations

import copy
import re
import time
import json
from pathlib import Path
from functools import lru_cache
from datetime import datetime, date
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .memory import digest
from .transcript_document import CorrectionConflict

VERSION = 'meeting-state.v1'
REQUESTS = 'meeting_state_requests'
RESULTS = 'meeting_state_results'
LEASE = 180
MAX_ATTEMPTS = 3
MAX_CLOSED_PROPOSALS = 10000
MAX_LINKS = 5000
SOURCE_CHARS = 12000
CHUNK_CHARS = 10000
ITEM_TYPES = {'question', 'claim', 'topic', 'agenda', 'task', 'correction', 'answer', 'commitment', 'agreement', 'decision', 'evidence', 'conclusion', 'suggestion'}
SUMMARY_IDS = {'current': 'summary-current', 'meeting': 'summary-meeting'}
FAST_TYPES = ITEM_TYPES - {'evidence', 'conclusion', 'suggestion'}
STATUSES = {
    'question': {'open', 'answered', 'deferred', 'withdrawn'},
    'agenda': {'pending', 'in_progress', 'completed', 'deferred', 'uncertain'},
    'task': {'proposed', 'accepted', 'in_progress', 'blocked', 'completed', 'cancelled', 'uncertain'},
    'conclusion': {'proposed', 'tentative', 'agreed', 'contested', 'unresolved', 'deferred', 'superseded'},
}
BASELINE = {'version': 1, 'external_search': False, 'sources': 'meeting-authorized-only',
            'uncertainty': 'preserve', 'egress': 'configured-endpoint-only'}
DETAIL_KEYS = {'claim_type', 'tags', 'assignees_text', 'deadline_text', 'deadline_date', 'timezone',
               'deliverables', 'definition_of_done', 'agenda_ids', 'question_id', 'source_status', 'epistemic_basis', 'topic_id', 'suggestion_kind', 'assignee_speaker_ids'}


@lru_cache(maxsize=4)
def validator(role):
    import jsonschema
    from referencing import Registry, Resource
    rel = Path('meetings/contracts/meeting-state.v1/meeting-state.schema.json')
    path = next((p / rel for p in Path(__file__).resolve().parents if (p / rel).is_file()), None)
    if path is None:
        raise RuntimeError('Missing meeting-state contract')
    schema = json.loads(path.read_text(encoding='utf-8'))
    shape = {'fast': 'FastOutput', 'reason': 'ReasonOutput', 'result': 'Result', 'view': 'StateView'}[role]
    return jsonschema.Draft202012Validator({'$ref': schema['$id'] + '#/$defs/' + shape},
        registry=Registry().with_resource(schema['$id'], Resource.from_contents(schema)))


def details(value):
    if not isinstance(value, dict) or not set(value) <= DETAIL_KEYS or len(str(value)) > 4000:
        raise ValueError('Invalid item details')
    if any(not isinstance(v, (str, list)) or (isinstance(v, list) and (len(v) > 20 or any(not isinstance(x, str) for x in v))) for v in value.values()):
        raise ValueError('Expected text or text lists')
    if value.get('claim_type') not in (None, 'factual_assertion', 'observation', 'opinion', 'assumption', 'hypothesis', 'proposal'):
        raise ValueError('Invalid claim type')
    if 'assignee_speaker_ids' in value and (not isinstance(value['assignee_speaker_ids'], list)
            or len(value['assignee_speaker_ids']) > 10 or any(not isinstance(v, str) for v in value['assignee_speaker_ids'])):
        raise ValueError('Invalid assignee speaker IDs')
    if value.get('source_status') not in (None, 'accessible', 'unavailable', 'unverifiable', 'stale'):
        raise ValueError('Invalid source status')
    basis = value.get('epistemic_basis', [])
    basis = [basis] if isinstance(basis, str) else basis
    if not set(basis) <= {'reported', 'observed', 'reasoned', 'inferred', 'corroborated', 'disputed'}:
        raise ValueError('Invalid epistemic basis')
    if value.get('deadline_date'):
        if not isinstance(value['deadline_date'], str) or not re.match(r'^\d{4}-\d{2}-\d{2}(?:T.*)?$', value['deadline_date']):
            raise ValueError('Expected an ISO deadline')
        if not value.get('timezone'):
            raise ValueError('A normalized deadline requires an IANA timezone')
        try:
            parsed = (datetime.fromisoformat if 'T' in value['deadline_date'] else date.fromisoformat)(value['deadline_date'].replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('Invalid ISO deadline') from None
        if isinstance(parsed, datetime) and parsed.tzinfo is None:
            try:
                parsed = parsed.replace(tzinfo=ZoneInfo(value['timezone']))
            except ZoneInfoNotFoundError:
                raise ValueError('A normalized deadline requires an IANA timezone') from None
    if value.get('timezone'):
        try:
            ZoneInfo(value['timezone'])
        except (ValueError, TypeError, ZoneInfoNotFoundError):
            raise ValueError('Invalid deadline timezone') from None
    return copy.deepcopy(value)


def merge_patch(target, patch):
    target.update({k: copy.deepcopy(v) for k, v in patch.items() if k != 'details'})
    if 'details' in patch:
        target['details'] = dict(target.get('details', {}), **patch['details'])


def lock_patch(target, patch):
    locked = set(target.get('manual_fields', []))
    for key, value in patch.items():
        if key == 'details':
            locked.update('details.' + k for k, v in value.items() if target.get('details', {}).get(k) != v)
        elif key != 'evidence':
            locked.add(key)
    target['manual_fields'] = sorted(locked)


def conflicts_with_human(item, patch):
    if item.get('human') and patch.get('withdrawn') and not item.get('withdrawn'):
        return True
    locked = set(item.get('manual_fields', ['text', 'type', 'status', 'details'] if item.get('human') else []))
    return any((any(('details' in locked or 'details.' + k in locked) and item.get('details', {}).get(k) != v for k, v in value.items())
                if key == 'details' else key in locked and item.get(key) != value) for key, value in patch.items())


def summary_record(state, field):
    key = SUMMARY_IDS[field]
    if key not in state['items']:
        state['items'][key] = {'id': key, 'type': 'summary', 'text': state['summaries'][field], 'revision': 0,
            'status': 'current', 'human': False, 'provisional': False, 'stale': False, 'evidence': [],
            'sequence': 0, 'document_dependencies': list(state['summaries'].get('document_ids', []))}
    return state['items'][key]


def project_summaries(state):
    manual, documents, stale = [], set(), False
    for field, key in SUMMARY_IDS.items():
        item = state['items'].get(key)
        state['summaries'][field + '_revision'] = item['revision'] if item else 0
        state['summaries'][field + '_provenance'] = copy.deepcopy(item.get('provenance', {})) if item else {'origin': 'awaiting-reconciliation'}
        if not item:
            continue
        state['summaries'][field] = '' if item.get('hidden') else item['text']
        stale |= bool(item.get('stale'))
        if item.get('human'):
            manual.append(field)
        if not item.get('hidden'):
            documents.update(item.get('document_dependencies', []))
    state['summaries']['manual_fields'] = manual
    state['summaries']['stale'] = stale
    if any(key in state['items'] for key in SUMMARY_IDS.values()):
        state['summaries']['document_ids'] = sorted(documents)


def propose(state, target_id, target, patch, evidence, electorate, read_documents, now):
    pid = digest([target_id, target['revision'], patch, state['policy']['version']])
    if pid in state['proposals'] or pid in state['closed_proposals'] or not evidence:
        return
    state['proposals'][pid] = {'id': pid, 'item_id': target_id, 'expected_revision': target['revision'],
        'patch': copy.deepcopy(patch), 'evidence': copy.deepcopy(evidence), 'status': 'pending', 'votes': [],
        'document_dependencies': read_documents, 'electorate': sorted(set(electorate)), 'mode': state['config']['approval'],
        'approvers': state['config']['approvers'], 'quorum': state['config']['quorum']}
    event(state, 'reason', 'proposal', {'proposal_id': pid, 'item_id': target_id}, now)


def close_proposal(state, proposal_id, now):
    closed = state.setdefault('closed_proposals', {})
    closed[proposal_id] = now
    if len(closed) > MAX_CLOSED_PROPOSALS:
        for key in sorted(closed, key=closed.get)[:len(closed)-MAX_CLOSED_PROPOSALS]:
            del closed[key]


def summary_evidence(job, by_id):
    refs = []
    priority = list(job.get('context', {}).get('raw_coverage', {}))
    sources_ordered = sorted(job['segments'], key=lambda s: (0 if evidence_id(s) in priority else 1,
        priority.index(evidence_id(s)) if evidence_id(s) in priority else job['segments'].index(s)))
    for source in sources_ordered[:6]:
        actual = by_id[evidence_id(source)]
        quote = source['text'][:1000]
        if quote not in actual['text']:
            quote = actual['text'][:1000]
        if not quote.strip():
            continue
        if source.get('document_id'):
            refs.append({'document_id': source['document_id'], 'sha256': source['sha256'], 'quote': quote})
        else:
            refs.append({**{k: actual.get(k) for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_name', 'start_ms')}, 'quote': quote})
    return refs


def fresh(now=None):
    stamp = time.time() if now is None else now
    return {'version': VERSION, 'enabled': False, 'revision': 0, 'epoch': 0,
            'metadata': {'created_at': stamp, 'updated_at': stamp, 'participants': []}, 'last_processed_segment_id': None,
            'config': {'fast_seconds': 30, 'reason_seconds': 120, 'eagerness': 'normal',
                       'timezone': 'UTC', 'timezone_source': 'default', 'approval': 'host', 'approvers': [], 'quorum': 1},
            'goal': {'text': '', 'revision': 0, 'human': False, 'source': 'unset', 'tentative': False, 'evidence': [], 'document_dependencies': []}, 'items': {}, 'links': [],
            'summaries': {'current': '', 'meeting': '', 'revision': 0}, 'covered': {}, 'reason_covered': {}, 'source_seen': {},
            'jobs': {}, 'inflight': {}, 'documents': {}, 'proposals': {}, 'closed_proposals': {}, 'sequence': 0, 'reasoned_sequence': 0,
            'last_reason_at': 0, 'boundary_sequence': 0, 'final': 'pending', 'policy': BASELINE.copy(), 'active_topic': None, 'suggested_topics': {}}


def event(state, actor, kind, change, now):
    state['revision'] += 1
    state.setdefault('metadata', {'created_at': now})['updated_at'] = now
    state.setdefault('_events', []).append({'id': str(uuid4()), 'sequence': state['revision'],
        'actor': str(actor), 'kind': kind, 'change': copy.deepcopy(change), 'at': now, 'policy_version': state['policy']['version']})


def acknowledge_plan_only(state, canon, now):
    if not canon['segments'] and not any(item.get('evidence') for item in state['items'].values()):
        state['reasoned_sequence'] = state['sequence']
        state['last_reason_at'] = now


def apply_policy(state, payload, now):
    allowed = {'enabled', 'version', 'readers', 'editors', 'approvers', 'approval_modes', 'audit_days', 'external_search'}
    if not isinstance(payload, dict) or not set(payload) <= allowed or type(payload.get('version')) is not int or payload['version'] < 1:
        raise ValueError('Invalid organization policy')
    if state['policy'].get('organization') and payload['version'] <= state['policy']['version']:
        raise CorrectionConflict('Policy version must increase')
    for key in ('readers', 'editors', 'approvers'):
        if key in payload and (not isinstance(payload[key], list) or len(payload[key]) > 200 or any(type(v) is not int or v <= 0 for v in payload[key])):
            raise ValueError('Invalid policy roles')
    if 'audit_days' in payload and (type(payload['audit_days']) is not int or not 1 <= payload['audit_days'] <= 3650):
        raise ValueError('Invalid retention days')
    if 'approval_modes' in payload and (not isinstance(payload['approval_modes'], list) or not set(payload['approval_modes']) <= {'host', 'named', 'any', 'quorum', 'unanimous'}):
        raise ValueError('Invalid approval modes')
    if any(k in payload and type(payload[k]) is not bool for k in ('enabled', 'external_search')):
        raise ValueError('Expected policy booleans')
    state['policy'] = dict(BASELINE, **{k: v for k, v in payload.items() if k != 'enabled'}, organization=payload.get('enabled', True)) if payload.get('enabled', True) else dict(BASELINE, version=payload['version'])
    revoke_jobs(state)
    for pid, proposal in list(state['proposals'].items()):
        proposal['status'] = 'stale'
        event(state, 'operator', 'proposal_closed', {'proposal': proposal}, now)
        close_proposal(state, pid, now)
        target = state['goal'] if proposal['item_id'] == 'goal' else state['items'].get(proposal['item_id'])
        if target:
            state['sequence'] += 1
            target['sequence'] = state['sequence']
        del state['proposals'][pid]
    event(state, 'operator', 'policy', {'version': payload['version']}, now)


def permitted(state, actor, role):
    policy = state['policy']
    return not policy.get('organization') or role not in policy or actor in policy[role]


def revoke_jobs(state):
    for role, job in state['jobs'].items():
        if role in ('fast', 'reason') and job.get('status') == 'running' and job.get('admitted'):
            state['inflight'][role] = {'generation': job['generation'], 'until': job['lease_until']}
    state['epoch'] += 1
    state['jobs'] = {}


def source_key(s):
    return digest({k: s.get(k) for k in ('segment_id', 'revision', 'speaker_id', 'speaker_revision', 'text', 'document_id', 'sha256')})


def source_projection(s):
    if s.get('document_id'):
        return {k: s[k] for k in ('document_id', 'sha256', 'workspace_id', 'path', 'text')}
    return {k: s.get(k) for k in ('segment_id', 'revision', 'speaker_id', 'speaker_revision', 'speaker_status', 'speaker_name', 'start_ms', 'end_ms', 'text')}


def evidence_id(ref):
    return ref.get('document_id') or ref.get('segment_id')


def sources(canon, state):
    transcript = {s['segment_id']: dict(s, speaker_status=state.get('metadata', {}).get('speaker_status', {}).get(s.get('speaker_id'), 'unknown'))
                  for s in canon['segments']}
    return transcript | {key: d for key, d in state.get('documents', {}).items() if d['active']}


def grounded(refs, by_id):
    if not isinstance(refs, list) or not refs or len(refs) > 30:
        return False
    for e in refs:
        if not isinstance(e, dict) or not isinstance(e.get('quote'), str) or not e['quote'].strip():
            return False
        s = by_id.get(evidence_id(e))
        if not s or e['quote'] not in s['text']:
            return False
        if e.get('document_id'):
            if e.get('sha256') != s.get('sha256'):
                return False
        elif e.get('revision') != s['revision'] or e.get('speaker_revision', 0) != s.get('speaker_revision', 0):
            return False
    return True


def canonical_evidence(refs, by_id):
    return [({'document_id': e['document_id'], 'sha256': by_id[e['document_id']]['sha256'], 'quote': e['quote']} if e.get('document_id') else
             {**{k: by_id[e['segment_id']].get(k) for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_status', 'speaker_name', 'start_ms')},
              'quote': e['quote']}) for e in refs]


def reconcile(state, canon, status, now):
    """Invalidate only affected dependencies; maintain timers without incoming transcript frames."""
    by_id = sources(canon, state)
    closed = state.setdefault('closed_proposals', {})
    ended_at = state.get('ended_at')
    cutoff = ended_at + int(state['policy'].get('audit_days', 14)) * 86400 if ended_at else None
    if cutoff and now > cutoff:
        for pid, closed_at in list(closed.items()):
            if closed_at < cutoff:
                del closed[pid]
    for role in ('fast', 'reason'):
        job = state['jobs'].get(role, {})
        if job.get('status') == 'running' and any(key not in by_id or source_key(by_id[key]) != fp
                                                   for key, fp in job.get('source_keys', {}).items()):
            if job.get('admitted') and job.get('lease_until', 0) > now:
                state['inflight'][role] = {'generation': job['generation'], 'until': job['lease_until']}
            state['jobs'][role] = {'status': 'pending', 'attempts': 0, 'retry_at': 0, 'error': 'source_changed',
                                   'fingerprint': None}
    revised = [s['segment_id'] for s in canon['segments'] if s['segment_id'] in state['reason_covered'] and state['reason_covered'][s['segment_id']] != source_key(s)]
    if revised and not state['summaries'].get('stale'):
        state['summaries']['stale'] = True
        state['final'] = 'pending'
        state['last_reason_at'] = 0
        if state.get('wiki') == 'published':
            state['wiki'] = 'conflict'
        event(state, 'system', 'summary_source_stale', {'segments': revised}, now)
    referenced = {e['document_id'] for item in [*state['items'].values(), state['goal']] for e in item.get('evidence', []) if e.get('document_id')}
    referenced |= {key for item in [*state['items'].values(), state['goal']] for key in item.get('document_dependencies', [])}
    referenced |= {key for link in state['links'] for key in link.get('document_dependencies', [])}
    referenced |= {e['document_id'] for link in state['links'] for e in link.get('evidence', []) if e.get('document_id')}
    unavailable = (referenced | set(state['summaries'].get('document_ids', []))) - {key for key, doc in state['documents'].items() if doc['active']}
    if unavailable & set(state['summaries'].get('document_ids', [])):
        before = copy.deepcopy(state['summaries'])
        state['summaries'] = {'current': '', 'meeting': '', 'revision': state['revision'], 'document_ids': [], 'stale': True}
        state['reasoned_sequence'] = 0
        state['reason_covered'] = {}
        state['last_reason_at'] = 0
        state['final'] = 'pending'
        if state.get('wiki') == 'published':
            state['wiki'] = 'conflict'
        event(state, 'system', 'summary_source_stale', {'before': before, 'after': state['summaries']}, now)
    if (set(state['goal'].get('document_dependencies', [])) & unavailable
            or any(e.get('document_id') in unavailable for e in state['goal'].get('evidence', []))):
        state['goal']['hidden'] = True
        state['goal']['stale'] = True
    else:
        goal_stale = bool(state['goal'].get('evidence')) and not grounded(state['goal']['evidence'], by_id)
        if goal_stale and not state['goal'].get('stale'):
            state['goal'].update(stale=True, revision=state['goal']['revision'] + 1)
            state['sequence'] += 1
            event(state, 'system', 'goal_source_stale', {'before': state['goal']['text']}, now)
            state['final'] = 'pending'
            if state.get('wiki') == 'published':
                state['wiki'] = 'conflict'
        elif state['goal'].get('hidden') and not goal_stale:
            state['goal'].update(hidden=False, stale=False)
    for item in state['items'].values():
        private_source = bool(set(item.get('document_dependencies', [])) & unavailable) or any(e.get('document_id') in unavailable for e in item.get('evidence', []))
        if private_source and state['final'] == 'complete':
            state['final'] = 'pending'
            if state.get('wiki') == 'published':
                state['wiki'] = 'conflict'
        if private_source and item['type'] != 'summary' and not item.get('human') and item.get('evidence') and all(e.get('document_id') for e in item['evidence']):
            safe_ref = next((e for e in item['evidence'] if e['document_id'] not in unavailable), None)
            if safe_ref:
                before = copy.deepcopy(item)
                item.update(type='evidence', text=safe_ref['quote'], evidence=[safe_ref], document_dependencies=[safe_ref['document_id']],
                            provisional=True, stale=False, hidden=False, status='proposed', details={'source_status': 'accessible', 'epistemic_basis': 'reported'},
                            provenance={'origin': 'model-extracted'}, revision=item['revision'] + 1)
                state['sequence'] += 1
                item['sequence'] = state['sequence']
                if state['active_topic'] == item['id']:
                    state['active_topic'] = None
                event(state, 'system', 'source_reextract', {'before': before, 'after': item}, now)
                continue
        stale = private_source or (bool(item.get('evidence')) and not grounded(item['evidence'], by_id))
        if stale and not item.get('stale'):
            item['stale'] = True
            if item.get('details', {}).get('source_status') == 'accessible':
                item['details']['source_status'] = 'stale'
            item['revision'] += 1
            state['sequence'] += 1
            if state['final'] == 'complete':
                state['final'] = 'pending'
            if item['type'] == 'summary' and state.get('wiki') == 'published':
                state['wiki'] = 'conflict'
            event(state, 'system', 'source_stale', {'item_id': item['id']}, now)
        if private_source:
            if not item.get('hidden'):
                for e in item.get('evidence', []):
                    if e.get('segment_id'):
                        state['covered'].pop(e['segment_id'], None)
            item['hidden'] = True
        elif item.get('hidden') and not stale:
            item.update(hidden=False, stale=False, revision=item['revision'] + 1)
            state['sequence'] += 1
            item['sequence'] = state['sequence']
    for pid, p in list(state['proposals'].items()):
        if p['status'] != 'pending':
            continue
        target = state['goal'] if p['item_id'] == 'goal' else state['items'].get(p['item_id'], {})
        if status in ('completed', 'failed'):
            p['status'] = 'expired'
        elif target.get('revision') != p['expected_revision'] or not grounded(p['evidence'], by_id) or set(p.get('document_dependencies', [])) & unavailable:
            p['status'] = 'stale'
        if p['status'] != 'pending':
            event(state, 'system', 'proposal_closed', {'proposal': p}, now)
            close_proposal(state, pid, now)
            del state['proposals'][pid]
    project_summaries(state)
    state['summaries']['stale'] = bool(state['summaries'].get('stale') or revised)
    missing = [s for s in canon['segments'] if state['covered'].get(s['segment_id']) != source_key(s)]
    for s in canon['segments']:
        key, fingerprint = s['segment_id'], source_key(s)
        if state['source_seen'].get(key, {}).get('fingerprint') != fingerprint:
            state['source_seen'][key] = {'fingerprint': fingerprint, 'at': now}
    state['pending_reason_sources'] = sum(state['reason_covered'].get(s['segment_id']) != source_key(s) for s in canon['segments'])
    running = state['jobs'].get('fast', {})
    queued = [s for s in missing if not (running.get('status') == 'running' and running.get('lease_until', 0) > now
              and running.get('source_keys', {}).get(s['segment_id']) == source_key(s))]
    state['window_at'] = min((state['source_seen'][s['segment_id']]['at'] for s in queued), default=None)
    if status in ('completed', 'failed'):
        state.setdefault('ended_at', now)
        fp = digest([(s['segment_id'], source_key(s)) for s in canon['segments']])
        # Wait for terminal durable source to settle across scheduler sweeps.
        if state.get('terminal_source') != fp:
            state.update(terminal_source=fp, terminal_observed_at=now, final='pending', drain_complete=False)
        if now - state['ended_at'] > 120 and state['final'] != 'complete':
            state['final'] = 'incomplete'
    return missing


def configure(state, payload, actor, owner, electorate, status, now):
    if str(actor) != str(owner):
        raise PermissionError('Only meeting owner may configure the assistant')
    if status in ('completed', 'failed'):
        raise CorrectionConflict('Meeting state is read-only after meeting end')
    allowed = {'enabled', 'fast_seconds', 'reason_seconds', 'eagerness', 'timezone', 'approval', 'approvers', 'quorum'}
    if not isinstance(payload, dict) or not set(payload) <= allowed:
        raise ValueError('Invalid meeting-state configuration')
    if 'enabled' in payload and type(payload['enabled']) is not bool:
        raise ValueError('Expected enabled boolean')
    cfg = dict(state['config'])
    for key, choices in (('fast_seconds', (15, 30)), ('reason_seconds', (60, 120, 300)),
                         ('eagerness', ('low', 'normal', 'high')), ('approval', ('host', 'named', 'any', 'quorum', 'unanimous'))):
        if key in payload:
            if payload[key] not in choices or isinstance(payload[key], bool):
                raise ValueError(f'Invalid {key}')
            cfg[key] = payload[key]
    if 'timezone' in payload:
        try:
            ZoneInfo(payload['timezone'])
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            raise ValueError('Expected an IANA timezone') from None
        cfg.update(timezone=payload['timezone'], timezone_source='host')
    if 'approvers' in payload:
        if not isinstance(payload['approvers'], list) or len(payload['approvers']) > 100 or any(type(v) is not int or v <= 0 for v in payload['approvers']):
            raise ValueError('Invalid approvers')
        cfg['approvers'] = sorted(set(payload['approvers']))
    if 'quorum' in payload:
        if type(payload['quorum']) is not int or not 1 <= payload['quorum'] <= 100:
            raise ValueError('Invalid quorum')
        cfg['quorum'] = payload['quorum']
    if cfg['approval'] == 'named' and not cfg['approvers']:
        raise ValueError('Named approval requires at least one approver')
    if not set(cfg['approvers']) <= set(electorate):
        raise ValueError('Named approvers must currently be authorized meeting viewers')
    if cfg['approval'] == 'quorum' and cfg['quorum'] > len(set(electorate)):
        raise ValueError('Quorum exceeds the current authorized electorate')
    if cfg['approval'] not in state['policy'].get('approval_modes', [cfg['approval']]) and ('approval' in payload or payload.get('enabled') is not False):
        raise PermissionError('Meeting approval setting conflicts with organization policy')
    timezone_changed = cfg['timezone'] != state['config']['timezone']
    semantic_change = timezone_changed or ('enabled' in payload and state['enabled'] != payload['enabled'])
    if semantic_change:
        revoke_jobs(state)
    state['config'] = cfg
    if timezone_changed:
        for item in state['items'].values():
            if item.get('details', {}).get('deadline_date') and 'details.deadline_date' not in item.get('manual_fields', []):
                before = copy.deepcopy(item)
                item['details'].pop('deadline_date')
                item['revision'] += 1
                state['sequence'] += 1
                item['sequence'] = state['sequence']
                event(state, actor, 'timezone_review', {'before': before, 'after': item}, now)
        state['sequence'] += 1
        state['last_reason_at'] = 0
    if 'enabled' in payload:
        state['enabled'] = payload['enabled']
        if payload['enabled']:
            state['ever_enabled'] = True
    event(state, actor, 'configure', payload, now)


def shortlist(state, segments):
    terms = set(re.findall(r'\w+', ' '.join(s['text'] for s in segments).casefold()))
    items = [i for i in state['items'].values() if i['type'] != 'summary' and not i.get('stale') and not i.get('withdrawn')]
    ranked = sorted(items, key=lambda i: (len(terms & set(re.findall(r'\w+', i['text'].casefold()))), i.get('sequence', 0)), reverse=True)
    result = []
    for item in ranked:
        value = {k: item.get(k) for k in ('id', 'type', 'text', 'status', 'details', 'revision', 'human', 'manual_fields', 'document_dependencies')}
        value['source_ids'] = [evidence_id(e) for e in item.get('evidence', [])]
        if len(result) >= 12 or sum(len(str(v)) for v in result) + len(str(value)) > 8000:
            break
        result.append(value)
    return result


def host_agenda_context(state):
    agenda, size = [], 2
    for item in sorted(state['items'].values(), key=lambda i: (i.get('created_sequence', 0), i['id'])):
        if not eligible_host_agenda(item):
            continue
        entry = {k: item[k] for k in ('id', 'text')}
        cost = len(json.dumps(entry, ensure_ascii=False)) + (2 if agenda else 0)
        if len(agenda) == 20 or size + cost > 6000:
            break
        agenda.append(entry)
        size += cost
    return agenda


def eligible_host_agenda(item):
    return item.get('type') == 'agenda' and item.get('human') and not any(
        item.get(key) for key in ('hidden', 'stale', 'withdrawn'))


def claim(state, canon, status, role, owner, now):
    missing = reconcile(state, canon, status, now)
    if role == 'publish':
        old = state['jobs'].get(role, {})
        if (not state['enabled'] or state['final'] != 'complete' or state.get('wiki') in ('published', 'conflict', 'export_only')
                or old.get('lease_until', 0) > now or old.get('status') == 'failed'):
            return None
        attempts = old.get('attempts', 0) + 1
        if attempts > MAX_ATTEMPTS:
            old.update(status='failed', error='publication_attempts_exhausted')
            return None
        job = {'role': role, 'generation': str(uuid4()), 'epoch': state['epoch'], 'status': 'running',
               'attempts': attempts, 'lease_until': now + LEASE, 'queued_at': now,
               'fingerprint': digest([state['revision'], state['summaries']]), 'markdown': render_markdown(state), 'policy': copy.deepcopy(state['policy']),
               'publication_revision': state['revision'],
               'audience_stamp': digest([state['metadata'].get('meeting_id'), sorted(state['metadata'].get('last_checked_subjects', [])), state['policy']]),
               'source_keys': {key: doc['sha256'] for key, doc in state['documents'].items() if doc.get('active')}}
        state['jobs'][role] = job
        return copy.deepcopy(job)
    if not state['enabled'] or state['final'] == 'complete' or role not in ('fast', 'reason'):
        return None
    if state['inflight'].get(role, {}).get('until', 0) > now:
        return None
    state['inflight'].pop(role, None)
    old = state['jobs'].get(role, {})
    if old.get('status') == 'running' and old.get('lease_until', 0) > now:
        return None
    if old.get('retry_at', 0) > now:
        return None
    terminal = status in ('completed', 'failed')
    segments, context = [], {}
    goal_context = state['goal'] if not state['goal'].get('hidden') else {'text': '', 'revision': state['goal']['revision'], 'human': True, 'stale': True}
    active_topic = state['active_topic'] if state['active_topic'] in state['items'] and not any(
        state['items'][state['active_topic']].get(k) for k in ('hidden', 'stale', 'withdrawn')) else None
    if role == 'fast':
        if not missing or (not terminal and now - (state['window_at'] if state['window_at'] is not None else now) < state['config']['fast_seconds']):
            return None
        for s in missing:
            if segments and sum(len(v['text']) for v in segments) + len(s['text']) > SOURCE_CHARS:
                break
            segments.append(source_projection(s))
        previous = []
        for s in reversed([s for s in canon['segments'] if s['end_ms'] <= segments[0]['start_ms']]):
            if len(previous) >= 8 or sum(len(v['text']) for v in previous) + len(s['text']) > 6000:
                break
            previous.insert(0, source_projection(s))
        context = {'goal': goal_context, 'items': shortlist(state, segments), 'summaries': state['summaries'],
                   'previous': previous, 'active_topic': active_topic, 'agenda': host_agenda_context(state)}
    else:
        if terminal and ((missing and state['jobs'].get('fast', {}).get('status') != 'failed')
                         or not state.get('drain_complete') or now - state.get('terminal_observed_at', now) < 5):
            return None
        raw_pending = [s for s in canon['segments'] if state['reason_covered'].get(s['segment_id']) != source_key(s)
                       and (state['covered'].get(s['segment_id']) == source_key(s) or state['jobs'].get('fast', {}).get('status') == 'failed')]
        if state['jobs'].get('fast', {}).get('status') != 'failed' and any(
                s['segment_id'] in state['reason_covered'] and state['reason_covered'][s['segment_id']] != source_key(s)
                and state['covered'].get(s['segment_id']) != source_key(s) for s in canon['segments']):
            return None
        changed = state['sequence'] > state['reasoned_sequence'] or bool(raw_pending)
        if not terminal and (not changed or (now - state['last_reason_at'] < state['config']['reason_seconds']
                                              and state['boundary_sequence'] <= state['reasoned_sequence'])):
            return None
        active = [i for i in state['items'].values() if i['type'] != 'summary' and not i.get('stale') and not i.get('withdrawn')]
        if not terminal and not canon['segments'] and not any(i.get('evidence') for i in active):
            return None
        pending = sorted((i for i in active if i.get('sequence', 0) > state['reasoned_sequence'] and i.get('evidence')), key=lambda i: i['sequence'])
        if not terminal and not pending and not raw_pending and not state['summaries']['meeting']:
            return None  # planning edits alone never start a model call
        selected = []
        for item in pending:
            if selected and (len(selected) >= 40 or sum(len(str(i)) for i in selected) + len(str(item)) > 40000):
                break
            selected.append(item)
        upto = selected[-1]['sequence'] if selected else state['sequence']
        agenda, agenda_chars = [], 0
        for item in sorted((i for i in active if i['type'] == 'agenda'), key=lambda i: (i.get('created_sequence', 0), i['id'])):
            compact = {k: item.get(k) for k in ('id', 'text', 'status', 'revision', 'human', 'manual_fields', 'details')}
            cost = len(str(compact))
            if len(agenda) >= 20 or agenda_chars + cost > 6000:
                break
            agenda.append(compact); agenda_chars += cost
        context = {'goal': goal_context, 'summaries': state['summaries'], 'items': selected,
                   'related': shortlist(state, [{'text': ' '.join(i['text'] for i in selected)}]),
                   'agenda': agenda, 'active_topic': active_topic,
                   'links': state['links'][-40:], 'upto_sequence': upto,
                   'suggested_topics': list(state['suggested_topics']),
                   'revised_sources': [s['segment_id'] for s in raw_pending if s['segment_id'] in state['reason_covered']],
                   'final': terminal and upto == state['sequence']}
        raw_group = []
        for s in raw_pending:
            if raw_group and sum(len(v['text']) for v in raw_group) + len(s['text']) > SOURCE_CHARS:
                break
            raw_group.append(s)
        context['raw_coverage'] = {s['segment_id']: source_key(s) for s in raw_group}
        context['final'] = context['final'] and len(raw_group) == len(raw_pending)
        # Only the exact evidence spans are needed here; do not reload arbitrarily long raw segments.
        refs = {}
        read_items = selected + [state['items'][item['id']] for item in context['related']]
        read_items.extend(state['items'][key] for key in SUMMARY_IDS.values() if key in state['items'])
        read_items.append(state['goal'])
        for item in read_items:
            for e in item.get('evidence', []):
                refs.setdefault(evidence_id(e), []).append(e['quote'])
        for item in selected + context['related'] + [goal_context, {'document_dependencies': state['summaries'].get('document_ids', [])}]:
            for key in item.get('document_dependencies') or []:
                if key in state['documents'] and state['documents'][key]['active']:
                    refs.setdefault(key, []).append(state['documents'][key]['text'])
        segments = [dict(source_projection(s), text='\n'.join(dict.fromkeys(refs[key]))) for key, s in sources(canon, state).items() if key in refs]
        by_source = {evidence_id(s): s for s in segments}
        by_source.update({s['segment_id']: source_projection(s) for s in raw_group})
        segments = list(by_source.values())
        if terminal and not segments and not canon['segments']:
            if status == 'failed':
                state['final'] = 'incomplete'
                if old.get('error') != 'no_finalized_transcript':
                    state['jobs'][role] = {'status': 'failed', 'error': 'no_finalized_transcript', 'attempts': MAX_ATTEMPTS}
                    event(state, 'system', 'source_unavailable', {}, now)
                return None
            state['summaries'] = {'current': 'No currently shareable sourced material is available.',
                                  'meeting': 'No finalized transcript was available.', 'revision': state['revision'], 'document_ids': []}
            state['reasoned_sequence'] = state['sequence']
            state['final'] = 'complete'
            event(state, 'system', 'empty_finalization', {}, now)
            state['summaries']['revision'] = state['revision']
            return None
        if not segments and canon['segments']:
            # The final review still receives bounded exact context if all raw windows are current.
            for s in reversed(canon['segments']):
                if segments and sum(len(v['text']) for v in segments) + len(s['text']) > SOURCE_CHARS:
                    break
                segments.insert(0, source_projection(s))
    for s in segments:
        if s.get('segment_id'):
            s['speaker_status'] = state.get('metadata', {}).get('speaker_status', {}).get(s.get('speaker_id'), 'unknown')
    context['meeting_started_at'] = state.get('metadata', {}).get('meeting_started_at')
    fingerprint = digest({'role': role, 'segments': [(evidence_id(s), source_key(s)) for s in segments], 'context': context, 'epoch': state['epoch']})
    if old.get('status') == 'failed' and old.get('fingerprint') == fingerprint:
        return None
    attempts = old.get('attempts', 0) if old.get('fingerprint') == fingerprint else 0
    if attempts >= MAX_ATTEMPTS:
        state['jobs'][role] = dict(old, status='failed', error='attempts_exhausted')
        return None
    current_sources = sources(canon, state)
    read_ids = {evidence_id(v) for v in segments}
    if role == 'fast':
        read_ids.update(s['segment_id'] for s in context.get('previous', []))
    if role == 'fast':
        read_ids.update(key for item in context['items'] + [goal_context, {'document_dependencies': state['summaries'].get('document_ids', [])}]
                        for key in item.get('document_dependencies') or [])
    read_items = {v['id'] for v in context['items'] + context.get('related', []) + context.get('agenda', [])}
    job = {'role': role, 'generation': str(uuid4()), 'epoch': state['epoch'], 'fingerprint': fingerprint,
           'status': 'running', 'lease_until': now + LEASE, 'attempts': attempts + 1,
           'queued_at': now, 'segments': segments, 'context': copy.deepcopy(context),
           'batch_started_at': state.get('window_at', now) if role == 'fast' else now,
           'retry_wait_ms': max(0, (now - old['failed_at']) * 1000) if old.get('failed_at') and old.get('status') == 'pending' else 0,
           'config': copy.deepcopy(state['config']), 'policy': copy.deepcopy(state['policy']),
           'item_revisions': {i: v['revision'] for i, v in state['items'].items()
                              if i in read_items},
           'source_keys': {key: source_key(s) for key, s in current_sources.items() if key in read_ids},
           'goal_revision': state['goal']['revision']}
    if role == 'reason':
        job['summary_revisions'] = {field: state['items'].get(key, {}).get('revision', 0) for field, key in SUMMARY_IDS.items()}
    state['jobs'][role] = job
    return copy.deepcopy(job)


def valid_job(state, payload, now):
    job = state['jobs'].get(payload.get('role'), {})
    return bool(state['enabled'] and job.get('status') == 'running' and job.get('lease_until', 0) > now
                and job.get('generation') == payload.get('generation') and job.get('epoch') == state['epoch']
                and (payload.get('role') != 'publish' or state['final'] == 'complete'))


def fail(state, role, now, code):
    job = state['jobs'][role]
    job.update(status='failed' if job['attempts'] >= MAX_ATTEMPTS else 'pending',
               error=code, failed_at=now, retry_at=now + min(30, 2 ** job['attempts']) + (int(job['generation'][-2:], 16) / 255), lease_until=0)
    compact_job(job)


def compact_job(job):
    for key in ('segments', 'context', 'policy', 'config', 'markdown', 'source_keys', 'item_revisions', 'summary_revisions', 'goal_revision', 'execution_key'):
        job.pop(key, None)


def accept(state, canon, payload, electorate, now):
    role = payload.get('role')
    if state['inflight'].get(role, {}).get('generation') == payload.get('generation'):
        state['inflight'].pop(role, None)
    job = state['jobs'].get(role, {})
    if job.get('status') == 'completed' and job.get('generation') == payload.get('generation'):
        return {'accepted': True, 'duplicate': True, 'publication_revision': job.get('published_revision')}
    if not valid_job(state, payload, now):
        return {'accepted': False, 'reason': 'stale_job'}
    if role == 'publish':
        outcome = payload.get('outcome')
        if outcome not in ('published', 'conflict', 'export_only'):
            fail(state, role, now, 'publication_failed')
            return {'accepted': False, 'reason': 'publication_failed'}
        state['wiki'] = outcome
        event(state, 'system', 'wiki_publication', {'outcome': outcome}, now)
        job.update(status='completed', lease_until=0)
        compact_job(job)
        return {'accepted': True}
    by_id = sources(canon, state)
    if any(sid not in by_id or key != source_key(by_id[sid]) for sid, key in job['source_keys'].items()):
        job.update(status='pending', lease_until=0, attempts=0)
        compact_job(job)
        return {'accepted': False, 'reason': 'stale_source'}
    if payload.get('heartbeat') is True:
        max_chunks = max(1, sum((len(s['text']) + CHUNK_CHARS - 1) // CHUNK_CHARS for s in job.get('segments', [])))
        job['lease_until'] = min(now + LEASE, job['queued_at'] + max_chunks * LEASE)
        return {'accepted': True, 'heartbeat': True, 'signal_ttl': max(1, int(job['lease_until'] - now))}
    if payload.get('error'):
        error = payload['error'] if isinstance(payload['error'], str) else 'invalid_error'
        code = {'model_not_configured': 'model_not_configured', 'LLMAuthError': 'model_auth_error',
                'LLMConfigError': 'model_config_error', 'ValidationError': 'schema_invalid', 'JSONDecodeError': 'invalid_json'}.get(error, 'model_unavailable')
        if code in ('model_not_configured', 'model_auth_error', 'model_config_error'):
            job['attempts'] = MAX_ATTEMPTS
        fail(state, role, now, code)
        return {'accepted': False, 'reason': 'model_error'}
    output = payload.get('output')
    if not isinstance(payload.get('provenance', {}), dict):
        fail(state, role, now, 'invalid_provenance')
        return {'accepted': False, 'reason': 'invalid_provenance'}
    if not isinstance(output, dict):
        fail(state, role, now, 'invalid_output')
        return {'accepted': False, 'reason': 'invalid_output'}
    if not validator(role).is_valid(output):
        fail(state, role, now, 'schema_invalid')
        return {'accepted': False, 'reason': 'schema_invalid'}
    # Validate the whole response before changing any canonical item.
    changes = output.get('items' if role == 'fast' else 'patches')
    if not isinstance(changes, list) or len(changes) > 40:
        fail(state, role, now, 'invalid_items')
        return {'accepted': False, 'reason': 'invalid_items'}
    if role == 'reason':
        summaries = output.get('summaries')
        ids = [c.get('id') for c in changes if isinstance(c, dict)]
        if (not isinstance(summaries, dict) or any(not isinstance(summaries.get(k), str) or len(summaries[k]) > 8000 for k in ('current', 'meeting'))
                or len(ids) != len(set(ids)) or not {i['id'] for i in job['context']['items']} <= set(ids)):
            fail(state, role, now, 'incomplete_reconciliation')
            return {'accepted': False, 'reason': 'incomplete_reconciliation'}
    fast_agenda = job['context'].get('agenda') if role == 'fast' else None
    offered_agenda_ids = {entry['id'] for entry in fast_agenda or []}
    for c in changes:
        if role == 'reason' and isinstance(c, dict) and 'text' not in c and c.get('id') in state['items']:
            c['text'] = state['items'][c['id']]['text']
        if (not isinstance(c, dict) or not isinstance(c.get('text'), str) or not 0 < len(c['text']) <= 2000
                or not grounded(c.get('evidence'), by_id)
                or (role == 'fast' and c.get('type') not in FAST_TYPES)
                or (role == 'reason' and c.get('id') not in job['item_revisions'])):
            fail(state, role, now, 'invalid_citation_or_item')
            return {'accepted': False, 'reason': 'invalid_citation_or_item'}
        try:
            raw_details = c.get('details', {})
            if fast_agenda is not None:
                selected = raw_details.get('agenda_ids')
                match = selected[0] if isinstance(selected, list) and len(selected) == 1 else None
                valid_match = (isinstance(match, str) and match in offered_agenda_ids
                               and eligible_host_agenda(state['items'].get(match, {})))
                raw_details = c['details'] = dict(raw_details, agenda_ids=[match] if valid_match else [])
            if (role == 'reason' and isinstance(raw_details, dict) and raw_details.get('deadline_date')
                    and not raw_details.get('timezone')):
                if state['config'].get('timezone_source') in ('host', 'calendar'):
                    raw_details = dict(raw_details, timezone=state['config']['timezone'])
                else:
                    raise ValueError('Cannot normalize deadline without an explicit meeting timezone')
            detail_value = details(raw_details)
            if detail_value.get('source_status') is not None:
                detail_value['source_status'] = 'accessible'  # exact current source was checked server-side
                c['details'] = detail_value
            if role == 'reason':
                current = state['items'].get(c.get('id'), {})
                status_set = STATUSES.get(c.get('type', current.get('type')))
                if c.get('status') is not None and (status_set is None or c['status'] not in status_set):
                    raise ValueError('Invalid status for item type')
                for speaker_id in detail_value.get('assignee_speaker_ids', []):
                    valid_assignment = any(e.get('segment_id') and by_id[e['segment_id']].get('speaker_id') == speaker_id
                        and by_id[e['segment_id']].get('speaker_status') in ('observed', 'confirmed')
                        and ((by_id[e['segment_id']].get('speaker_name') or '').casefold() in e['quote'].casefold()
                             or re.search(r"\b(?:i|i'll|i will|tôi|mình|em|anh|chị|we|we'll|we will)\b", e['quote'], re.I))
                        for e in c['evidence'])
                    if not valid_assignment:
                        raise ValueError('Assignee must be explicit and reliably identified')
            if role == 'fast' and not set(c.get('details', {})) <= {'claim_type', 'tags', 'assignees_text', 'deadline_text', 'deliverables', 'definition_of_done', 'agenda_ids', 'question_id', 'topic_id'}:
                raise ValueError('Reasoning-only details in extraction')
            if 'withdrawn' in c and type(c['withdrawn']) is not bool:
                raise ValueError()
            if 'type' in c and c['type'] not in ITEM_TYPES:
                raise ValueError()
        except ValueError:
            fail(state, role, now, 'invalid_details')
            return {'accepted': False, 'reason': 'invalid_details'}
        if role == 'fast' and c['evidence'][0].get('segment_id') not in {s['segment_id'] for s in job['segments']}:
            fail(state, role, now, 'context_only_extraction')
            return {'accepted': False, 'reason': 'context_only_extraction'}
        c['evidence'] = [({'document_id': e['document_id'], 'sha256': e['sha256'], 'quote': e['quote']} if e.get('document_id') else
                         {**{k: by_id[e['segment_id']].get(k) for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_name', 'start_ms')}, 'quote': e['quote']}) for e in c['evidence']]
    provenance = {k: str(payload.get('provenance', {}).get(k, ''))[:256] for k in ('model', 'provider', 'prompt_version', 'prompt_sha256')}
    provenance.update(role=role, source_fingerprint=job['fingerprint'])
    goal_stale = state['goal']['revision'] != job['goal_revision']
    stale = role == 'reason' and any(state['items'].get(iid, {}).get('revision') != rev
                                     for iid, rev in job['item_revisions'].items())
    aliases = {}
    created_ids = []
    event_start = len(state.get('_events', []))
    read_documents = sorted(set(job['source_keys']) & set(state['documents']))
    if role == 'fast':
        replacing = set(job['source_keys'])
        for item in state['items'].values():
            if item['type'] != 'summary' and item.get('stale') and any(evidence_id(e) in replacing for e in item.get('evidence', [])) and not item.get('human'):
                item['withdrawn'] = True
    for c in changes:
        if role == 'fast':
            anchor = c['evidence'][0]
            iid = digest([canon['meeting_id'], anchor['segment_id'], anchor['revision'], c['type'], anchor['quote'].strip()])
            normalized = ' '.join(c['text'].casefold().split())
            prior = next((i for i in state['items'].values() if i['type'] == c['type'] and not i.get('stale')
                          and not i.get('withdrawn') and ' '.join(i['text'].casefold().split()) == normalized), None)
            if prior:
                iid = prior['id']
                added = [e for e in c['evidence'] if e not in prior['evidence']]
                match = c.get('details', {}).get('agenda_ids')
                prior_details = prior['details']
                if (fast_agenda is not None and added and match and prior.get('provisional') and not prior.get('human')
                        and not prior_details.get('agenda_ids') and not prior_details.get('agenda_id')
                        and not {'details', 'details.agenda_ids'} & set(prior.get('manual_fields', []))):
                    before = copy.deepcopy(prior)
                    prior_details['agenda_ids'] = match
                else:
                    before = None
                if added:
                    prior['evidence'] = (prior['evidence'] + added)[-30:]
                    prior['revision'] += 1
                    state['sequence'] += 1
                    prior['sequence'] = state['sequence']
                    prior['document_dependencies'] = sorted(set(prior.get('document_dependencies', [])) | set(read_documents))
                    change = {'item_id': iid, 'evidence': added}
                    if before is not None:
                        change.update(before=before, after=prior)
                    event(state, 'fast', 'mention', change, now)
            aliases[c.get('key', iid)] = iid
            old_item = state['items'].get(iid)
            if old_item and not (old_item.get('withdrawn') and not old_item.get('human')):
                continue
            state['sequence'] += 1
            state['items'][iid] = {'id': iid, 'type': c['type'], 'text': c['text'], 'evidence': copy.deepcopy(c['evidence']), 'details': details(c.get('details', {})),
                'created_sequence': old_item.get('created_sequence', state['revision'] + 1) if old_item else state['revision'] + 1,
                'revision': old_item['revision'] + 1 if old_item else 1, 'sequence': state['sequence'], 'human': False, 'provisional': True,
                'stale': False, 'withdrawn': False, 'status': {'question': 'open', 'agenda': 'pending'}.get(c['type'], 'proposed'), 'provenance': dict(provenance, origin='model-extracted'),
                'document_dependencies': read_documents}
            created_ids.append(iid)
            event(state, 'fast', 'extract', {'item_id': iid, 'before': old_item or {}, 'after': state['items'][iid]}, now)
        else:
            item = state['items'].get(c['id'])
            if not item or item['revision'] != job['item_revisions'][c['id']]:
                stale = True
                continue
            patch = {k: copy.deepcopy(c[k]) for k in ('type', 'text', 'status', 'evidence', 'withdrawn', 'details') if k in c}
            if conflicts_with_human(item, patch):
                propose(state, item['id'], item, patch, c['evidence'], electorate, read_documents, now)
            else:
                if not item['provisional'] and all((all(item.get('details', {}).get(dk) == dv for dk, dv in v.items())
                                                   if k == 'details' else item.get(k) == v) for k, v in patch.items()):
                    continue
                before = copy.deepcopy(item)
                merge_patch(item, patch)
                item.update(provisional=False, provenance=dict(provenance, origin='model-reconciled'), revision=item['revision'] + 1)
                item['document_dependencies'] = read_documents
                event(state, 'reason', 'reconcile', {'item_id': item['id'], 'before': before, 'after': item}, now)
    if role == 'fast':
        for iid in created_ids:
            item = state['items'][iid]
            for field, kind in (('topic_id', 'topic'), ('question_id', 'question')):
                reference = item['details'].get(field, job['context'].get('active_topic') if field == 'topic_id' and item['type'] != 'topic' else None)
                reference = aliases.get(reference, reference) if isinstance(reference, str) else None
                target = state['items'].get(reference, {})
                if target.get('type') == kind and not any(target.get(k) for k in ('hidden', 'stale', 'withdrawn')):
                    item['details'][field] = reference
                else:
                    item['details'].pop(field, None)
            refs = item['details'].get('agenda_ids', [])
            refs = [refs] if isinstance(refs, str) else refs
            if refs and fast_agenda is None:
                resolved = [aliases.get(ref, ref) for ref in refs]
                item['details']['agenda_ids'] = [ref for ref in resolved if state['items'].get(ref, {}).get('type') == 'agenda'
                                               and not any(state['items'][ref].get(k) for k in ('hidden', 'stale', 'withdrawn'))]
        for staged in state.get('_events', [])[event_start:]:
            if staged['kind'] == 'extract' and staged['change']['item_id'] in created_ids:
                staged['change']['after'] = copy.deepcopy(state['items'][staged['change']['item_id']])
        for s in job['segments']:
            state['covered'][s['segment_id']] = source_key(s)
        state['last_processed_segment_id'] = job['segments'][-1]['segment_id']
        state['window_at'] = None
        links = output.get('links', [])
        if isinstance(links, list):
            known = state['items']
            for link in links[:30]:
                if not isinstance(link, dict):
                    continue
                left, right = aliases.get(link.get('from'), link.get('from')), aliases.get(link.get('to'), link.get('to'))
                if left in known and right in known and left != right and grounded(link.get('evidence'), by_id):
                    evidence = canonical_evidence(link['evidence'], by_id)
                    value = {'from': left, 'to': right, 'evidence': evidence, 'rationale': link.get('rationale', ''), 'provisional': True,
                             'document_dependencies': sorted({e['document_id'] for e in evidence if e.get('document_id')})}
                    prior = next((v for v in state['links'] if v.get('provisional') and v['from'] == left and v['to'] == right), None)
                    if prior:
                        prior['evidence'] = (prior['evidence'] + [e for e in value['evidence'] if e not in prior['evidence']])[-30:]
                    elif len(state['links']) < MAX_LINKS:
                        state['links'].append(value)
        current_name = ' '.join(state['items'].get(job['context'].get('active_topic'), {}).get('text', '').casefold().split())
        boundary_candidates = [item for item in state['items'].values() if item['type'] == 'topic'
                               and not any(item.get(k) for k in ('hidden', 'stale', 'withdrawn'))
                               and ' '.join(item['text'].casefold().split()) != current_name]
        repeated_topic = any(len({e.get('segment_id') for e in item.get('evidence', []) if e.get('segment_id')}) >= 2 for item in boundary_candidates)
        explicit_topic = output.get('explicit_transition') and any(c['type'] == 'topic' for c in changes)
        if repeated_topic or explicit_topic:
            state['boundary_sequence'] = state['sequence']
    else:
        if not stale:
            goal = output.get('goal')
            if goal and not goal_stale and grounded(goal['evidence'], by_id) and (goal['text'] != state['goal']['text'] or state['goal'].get('stale')):
                if state['goal']['human']:
                    if goal['text'] != state['goal']['text']:
                        propose(state, 'goal', state['goal'], goal, goal['evidence'], electorate, read_documents, now)
                else:
                    before = copy.deepcopy(state['goal'])
                    state['goal'].update(goal, revision=state['goal']['revision'] + 1, human=False, stale=False, source='model-inferred',
                                         tentative=True, hidden=False, document_dependencies=read_documents, provenance=provenance)
                    event(state, 'reason', 'inferred_goal', {'before': before, 'after': state['goal']}, now)
            topic = output.get('active_topic')
            if topic in state['items'] and state['items'][topic]['type'] == 'topic' and not state['items'][topic].get('hidden') and any(e.get('segment_id') for e in state['items'][topic]['evidence']):
                if state['active_topic'] != topic:
                    event(state, 'reason', 'topic_transition', {'from': state['active_topic'], 'to': topic}, now)
                state['active_topic'] = topic
            for relation in output.get('relations', [])[:30] if isinstance(output.get('relations', []), list) else []:
                if (isinstance(relation, dict) and relation.get('from') in job['item_revisions'] and relation.get('to') in job['item_revisions']
                        and relation.get('kind') in ('supports', 'contradicts', 'answers', 'clarifies', 'tests', 'depends_on', 'related')
                        and grounded(relation.get('evidence'), by_id)):
                    value = {k: relation[k] for k in ('from', 'to', 'kind')}
                    value['evidence'] = canonical_evidence(relation['evidence'], by_id)
                    value['provisional'] = False
                    value['document_dependencies'] = sorted({e['document_id'] for e in value['evidence'] if e.get('document_id')})
                    prior = next((v for v in state['links'] if not v.get('provisional') and all(v.get(k) == value.get(k) for k in ('from', 'to', 'kind'))), None)
                    if prior:
                        prior['evidence'] = (prior['evidence'] + [e for e in value['evidence'] if e not in prior['evidence']])[-30:]
                    elif len(state['links']) < MAX_LINKS:
                        state['links'].append(value)
                        event(state, 'reason', 'relation', {'relation': value}, now)
            for progress in output.get('progress', []):
                cooldown = state['suggested_topics'].get(progress['topic_id'])
                if cooldown and grounded(progress['evidence'], by_id) and any(
                    (e.get('document_id') and e['document_id'] not in cooldown.get('document_ids', [])) or
                    (e.get('segment_id') and by_id[e['segment_id']]['end_ms'] > cooldown['source_watermark']) for e in progress['evidence']):
                    state['suggested_topics'].pop(progress['topic_id'], None)
            # Distinct turns are not raw ASR fragments. Speaker switches or a meaningful pause
            # close a turn; unreliable identity does not establish repeat-turn evidence.
            turn_by_segment, turn, previous = {}, 0, None
            for s in canon['segments']:
                if previous is None or s.get('speaker_id') != previous.get('speaker_id') or s['start_ms'] - previous['end_ms'] > 2000:
                    turn += 1
                if s.get('speaker_id'):
                    turn_by_segment[s['segment_id']] = turn
                previous = s
            for suggestion in output.get('suggestions', []):
                topic = suggestion['topic_id']
                if topic not in state['items'] or state['items'][topic]['type'] != 'topic' or topic in state['suggested_topics'] or not grounded(suggestion['evidence'], by_id):
                    continue
                repeats = len({turn_by_segment[e['segment_id']] for e in suggestion['evidence'] if e.get('segment_id') in turn_by_segment})
                if suggestion['kind'] == 'stall' and repeats < {'low': 5, 'normal': 4, 'high': 3}[state['config']['eagerness']]:
                    continue
                iid = digest(['suggestion', topic, suggestion['text'], state['reasoned_sequence']])
                state['items'][iid] = {'id': iid, 'type': 'suggestion', 'text': suggestion['text'], 'evidence': suggestion['evidence'],
                    'created_sequence': state['revision'] + 1,
                    'details': {'topic_id': topic, 'suggestion_kind': suggestion['kind']}, 'revision': 1, 'sequence': 0,
                'status': 'proposed', 'human': False, 'provisional': False, 'stale': False, 'withdrawn': False, 'provenance': dict(provenance, origin='model-proactive'),
                    'document_dependencies': read_documents}
                state['suggested_topics'][topic] = {'item_id': iid, 'source_watermark': max((s.get('end_ms', 0) for s in job['segments']), default=0),
                                                   'document_ids': list(set(job['source_keys']) & set(state['documents']))}
                event(state, 'reason', 'suggestion', {'item_id': iid}, now)
            summary = output.get('summaries')
            if isinstance(summary, dict) and all(isinstance(summary.get(k), str) and len(summary[k]) <= 8000 for k in ('current', 'meeting')):
                refs = summary_evidence(job, by_id)
                for field in ('current', 'meeting'):
                    record = summary_record(state, field)
                    if record['revision'] != job.get('summary_revisions', {}).get(field, 0):
                        stale = stale or not record.get('human')
                        continue
                    if record['text'] == summary[field] and not record.get('hidden'):
                        continue
                    patch = {'text': summary[field], 'evidence': refs}
                    if conflicts_with_human(record, patch):
                        propose(state, record['id'], record, patch, refs, electorate, read_documents, now)
                    else:
                        before = copy.deepcopy(record)
                        merge_patch(record, patch)
                        record.update(revision=record['revision'] + 1, document_dependencies=read_documents, hidden=False, stale=False, provenance=dict(provenance, origin='model-reconciled'))
                        event(state, 'reason', 'summary', {'before': before, 'after': record}, now)
                project_summaries(state)
                state['summaries']['revision'] = state['revision']
            state['reasoned_sequence'] = max(state['reasoned_sequence'], job['context']['upto_sequence'])
            state['reason_covered'].update(job['context'].get('raw_coverage', {}))
            if goal_stale:
                stale = True
                state['last_reason_at'] = 0
            state['summaries']['stale'] = any(s['segment_id'] in state['reason_covered'] and state['reason_covered'][s['segment_id']] != source_key(s) for s in canon['segments'])
            state['last_reason_at'] = now
            if job['context'].get('final') and not stale and not goal_stale and state['sequence'] == job['context']['upto_sequence'] and all(
                    state['reason_covered'].get(s['segment_id']) == source_key(s) for s in canon['segments']) and not any(i.get('stale') for i in state['items'].values() if not i.get('withdrawn') and not i.get('hidden')):
                state['final'] = 'complete'
        else:
            state['last_reason_at'] = 0
    job.update(status='completed', lease_until=0, published_revision=state['revision'])
    compact_job(job)
    return {'accepted': True, 'stale_patches': stale, 'publication_revision': state['revision']}


def edit(state, payload, actor, status, now, canon):
    if status in ('completed', 'failed'):
        raise CorrectionConflict('Meeting state is read-only after meeting end')
    field = next((f for f, key in SUMMARY_IDS.items() if key == payload.get('id')), None)
    target = summary_record(state, field) if field else state['goal'] if payload.get('id') == 'goal' else state['items'].get(payload.get('id'))
    if target is None:
        raise ValueError('Unknown item')
    if target.get('hidden') and payload['id'] != 'goal' and not field:
        raise PermissionError('Item source is no longer shareable')
    if type(payload.get('expected_revision')) is not int or payload['expected_revision'] != target['revision']:
        raise CorrectionConflict('Field changed; reload before reapplying your draft')
    patch = payload.get('patch')
    if not isinstance(patch, dict) or not patch or not set(patch) <= {'text', 'status', 'details'}:
        raise ValueError('Expected a structured text/status patch')
    if field and set(patch) != {'text'}:
        raise ValueError('Summary edits require a text patch')
    if 'text' in patch and (not isinstance(patch['text'], str) or len(patch['text']) > (8000 if field else 2000)):
        raise ValueError('Text exceeds limit')
    if 'status' in patch and patch['status'] not in STATUSES.get(target.get('type'), set()):
        raise ValueError('Invalid item status')
    if 'details' in patch:
        details(patch['details'])
    before = copy.deepcopy(target)
    lock_patch(target, patch)
    merge_patch(target, patch)
    target.update(revision=target['revision'] + 1, human=True, last_editor=str(actor))
    if payload['id'] == 'goal' or field:
        target.update(tentative=False, hidden=False, stale=False, evidence=[], document_dependencies=[],
                      provenance={'origin': 'human-edited', 'actor': str(actor)})
        if payload['id'] == 'goal':
            target['source'] = 'host'
    elif target.get('stale') and not target.get('hidden') and 'text' in patch:
        target.update(stale=False, evidence=[])  # explicit human review; old citations remain in audit only
        if target.get('details', {}).get('source_status') == 'stale':
            target['details'].pop('source_status', None)
    state['sequence'] += 1
    target['sequence'] = state['sequence']
    event(state, actor, 'edit', {'id': payload['id'], 'before': before, 'after': target}, now)
    project_summaries(state)
    acknowledge_plan_only(state, canon, now)


def vote(state, payload, actor, owner, electorate, status, now):
    if not state['enabled'] or status in ('completed', 'failed'):
        raise CorrectionConflict('AI proposals are frozen or meeting has ended')
    if not permitted(state, actor, 'approvers'):
        raise PermissionError('Approval conflicts with organization policy')
    p = state['proposals'].get(payload.get('id'))
    if not p or p['status'] != 'pending':
        raise CorrectionConflict('Proposal is no longer pending')
    eligible = {v for v in set(p['electorate']) & set(electorate) if permitted(state, v, 'approvers')}
    p['roster_changed'] = bool(set(p['electorate']) - set(electorate))
    if p['mode'] == 'host':
        eligible &= {owner}
    elif p['mode'] == 'named':
        eligible &= set(p['approvers'])
    if actor not in eligible:
        raise PermissionError('Not an eligible approver')
    if type(payload.get('approve')) is not bool:
        raise ValueError('Expected approve boolean')
    if payload['approve'] and p['mode'] == 'quorum' and len(eligible) < p['quorum']:
        raise CorrectionConflict('Quorum unavailable after authorization changes; reject or replace the proposal')
    if not payload['approve']:
        p['status'] = 'rejected'
    else:
        p['votes'] = sorted(set(p['votes']) | {actor})
        required = len(eligible) if p['mode'] == 'unanimous' else p['quorum'] if p['mode'] == 'quorum' else 1
        if len(set(p['votes']) & eligible) >= required:
            target = state['goal'] if p['item_id'] == 'goal' else state['items'][p['item_id']]
            if target['revision'] != p['expected_revision']:
                raise CorrectionConflict('Proposal target changed')
            lock_patch(target, p['patch'])
            merge_patch(target, p['patch'])
            target.update(revision=target['revision'] + 1, human=True, last_editor=str(actor), provisional=False)
            target.update(hidden=False, stale=False)
            target['document_dependencies'] = p.get('document_dependencies', [])
            target['provenance'] = {'origin': 'human-approved-model-update', 'actor': str(actor)}
            if p['item_id'] == 'goal':
                target.update(source='host', tentative=False, evidence=[], document_dependencies=[])
            state['sequence'] += 1
            target['sequence'] = state['sequence']
            p['status'] = 'approved'
    event(state, actor, 'vote', {'proposal_id': p['id'], 'status': p['status'], 'proposal': p, 'authorization_changed': p['roster_changed']}, now)
    if p['status'] != 'pending':
        close_proposal(state, p['id'], now)
        del state['proposals'][p['id']]
    project_summaries(state)


def view(state, status, owner=False, archive_offset=0):
    """Allowlisted participant projection: never leak internal clocks, leases, or processing IDs."""
    if state is None or not state.get('ever_enabled'):
        return {'version': VERSION, 'configured': False, 'enabled': False, 'can_configure': owner, 'readonly': status in ('completed', 'failed')}
    ordered = [i for i in sorted(state['items'].values(), key=lambda i: (i.get('sequence', i.get('created_sequence', 0)), i['id']))
               if i['type'] != 'summary' and not i.get('withdrawn') and not i.get('hidden')]
    recent_raw, older = ordered[-100:], ordered[:-100]
    offset = max(0, min(int(archive_offset or 0), len(older)))
    archive_end = len(older) - offset
    archive_start = max(0, archive_end - 100)

    def render_evidence(refs, stale=False):
        return [] if stale else [(
            {'document_id': e['document_id'], 'quote': e['quote'], 'path': state['documents'][e['document_id']]['path'],
             'workspace_id': state['documents'][e['document_id']]['workspace_id'], 'sha256': e['sha256']}
            if e.get('document_id') else {k: e.get(k) for k in ('segment_id', 'quote', 'start_ms', 'speaker_name')}) for e in refs]

    def render_item(item):
        value = {k: copy.deepcopy(item[k]) for k in ('id', 'type', 'text', 'status', 'details', 'revision', 'human', 'manual_fields', 'provisional', 'stale', 'last_editor') if k in item}
        value['details'] = {k: copy.deepcopy(v) for k, v in item.get('details', {}).items() if k != 'assignee_speaker_ids'}
        speaker_map = state.get('metadata', {}).get('speaker_map', {})
        assignee_ids = item.get('details', {}).get('assignee_speaker_ids', [])
        if assignee_ids:
            value['details']['assignees'] = [speaker_map.get(sid, {}).get('name', 'Unresolved participant') for sid in assignee_ids]
        if item.get('provenance'):
            value['provenance'] = {k: item['provenance'][k] for k in ('origin', 'role', 'model', 'requested_by', 'actor') if item['provenance'].get(k) is not None}
        value['evidence'] = render_evidence(item.get('evidence', []), item.get('stale'))
        return value

    items = [render_item(i) for i in recent_raw]
    archive_items = [render_item(i) for i in older[archive_start:archive_end]]
    freshness = {}
    for role in ('fast', 'reason'):
        job = state['jobs'].get(role, {})
        pending = state.get('window_at') is not None if role == 'fast' else state.get('pending_reason_sources', 0) > 0 or state['sequence'] > state['reasoned_sequence']
        stage = job.get('status', 'idle')
        if not state['enabled']:
            stage = 'paused'
        elif state['inflight'].get(role, {}).get('until', 0) > time.time():
            stage = 'waiting_for_previous'
        elif stage in ('idle', 'completed') and pending:
            stage = 'pending'
        freshness[role] = {'status': stage, 'error': job.get('error'), 'covered': len(state['covered']) if role == 'fast' else len(state['reason_covered']) + len(state['summaries'].get('document_ids', []))}
    goal_view = {k: copy.deepcopy(v) for k, v in state['goal'].items() if k in ('text', 'revision', 'human', 'source', 'tentative', 'last_editor', 'provenance', 'stale')}
    if state['goal'].get('hidden'):
        goal_view = {'text': '', 'revision': state['goal']['revision'], 'source': 'unavailable', 'hidden': True}
    else:
        goal_view['evidence'] = render_evidence(state['goal'].get('evidence', []), state['goal'].get('stale'))
    return {'version': VERSION, 'configured': True, 'enabled': state['enabled'], 'can_configure': owner,
            'participants': copy.deepcopy(state.get('metadata', {}).get('participants', [])),
            'readonly': status in ('completed', 'failed'), 'revision': state['revision'], 'organization_policy': state['policy'].get('organization', False),
            'goal': goal_view, 'config': state['config'], 'items': items,
            'summaries': state['summaries'], 'final': state['final'],
            'source_notice': any(i.get('hidden') for i in state['items'].values()) or any(
                any(not state['documents'].get(key, {}).get('active') for key in link.get('document_dependencies', []))
                for link in state['links']),
            'wiki': state.get('wiki', 'failed' if state['jobs'].get('publish', {}).get('status') == 'failed' else 'pending'),
            'active_topic': state['active_topic'] if not state['items'].get(state['active_topic'], {}).get('hidden') else None,
            'links': [{k: v[k] for k in ('from', 'to', 'kind', 'evidence')} |
                      {'from_text': state['items'][v['from']]['text'], 'to_text': state['items'][v['to']]['text']} for v in state['links']
                      if not v.get('provisional') and v['from'] in state['items'] and v['to'] in state['items']
                      and not any(state['items'][node].get(key) for node in (v['from'], v['to']) for key in ('stale', 'hidden'))
                      and all(state['documents'].get(key, {}).get('active') for key in v.get('document_dependencies', []))
                      and all(not e.get('document_id') or state['documents'].get(e['document_id'], {}).get('active') for e in v.get('evidence', []))],
            'freshness': freshness, 'archive_items': archive_items, 'archive_offset': offset,
            'archive_count': len(older), 'archive_more': archive_start > 0,
            'proposals': [{k: copy.deepcopy(p.get(k)) for k in ('id', 'item_id', 'patch', 'status', 'votes', 'electorate', 'mode', 'quorum', 'roster_changed')} for p in state['proposals'].values() if p['status'] == 'pending']}


def public_event(e, state=None):
    result = {k: e[k] for k in ('sequence', 'actor', 'kind')}
    change = e.get('change', {})
    if change.get('id') or change.get('item_id'):
        result['target'] = change.get('id') or change.get('item_id')
    if state:
        target_id = change.get('id') or change.get('item_id')
        if target_id == 'goal':
            goal = state.get('goal', {})
            if goal.get('hidden'):
                return dict(result, redacted=True)
            result['target_text'] = goal.get('text', '')
        elif target_id in state.get('items', {}):
            target = state['items'][target_id]
            if target.get('hidden') or target.get('stale'):
                return dict(result, redacted=True)
            result['target_text'] = target.get('text', '')
    if state and (any(ref.get('document_id') and not state['documents'].get(ref['document_id'], {}).get('active')
                      for key in ('before', 'after') for ref in change.get(key, {}).get('evidence', [])) or
                  any(not state['documents'].get(doc, {}).get('active') for key in ('before', 'after') for doc in change.get(key, {}).get('document_dependencies', []))):
        return dict(result, redacted=True)
    if change.get('authorization_changed'):
        result['authorization_changed'] = True
    if change.get('status'):
        result['status'] = change['status']
    elif isinstance(change.get('proposal'), dict) and change['proposal'].get('status'):
        result['status'] = change['proposal']['status']
    for field in ('before', 'after'):
        if isinstance(change.get(field), dict):
            result[field] = {k: change[field][k] for k in ('type', 'text', 'status') if k in change[field]}
    return result


def transition(data, canon, status, action, payload, actor, owner, electorate, now=None):
    now = time.time() if now is None else now
    state = data.get('live_assist')
    if state is None and action == 'configure':
        state = data['live_assist'] = fresh(now)
    if state is None:
        if action == 'state':
            result = view(None, status, actor == owner)
            validator('view').validate(result)
            return result
        return None
    metadata = state.setdefault('metadata', {'created_at': now})
    metadata.update(meeting_id=canon['meeting_id'], last_checked_subjects=list(electorate))
    speakers = {s.get('speaker_id'): {'name': s.get('speaker_name') or 'Unknown speaker',
                 'status': metadata.get('speaker_status', {}).get(s.get('speaker_id'), 'unknown')}
                for s in canon['segments'] if s.get('speaker_id')}
    for participant in metadata.get('planned_participants', []):
        speakers.setdefault('planned:' + participant, {'name': participant, 'status': 'planned'})
    metadata['participants'] = list(speakers.values())
    if action in ('state', 'export', 'configure', 'edit', 'add', 'vote', 'ingest-documents', 'remove-source') and not permitted(state, actor, 'readers'):
        raise PermissionError('State visibility restricted by organization policy')
    if action in ('edit', 'add') and not permitted(state, actor, 'editors'):
        raise PermissionError('Editing restricted by organization policy')
    reconcile(state, canon, status, now)
    if action == 'export':
        return {'markdown': render_markdown(state), 'complete': state['final'] == 'complete'}
    if action == 'configure':
        configure(state, payload, actor, owner, electorate, status, now)
    elif action == 'policy':
        apply_policy(state, payload, now)
        return {'applied': True, 'version': state['policy']['version']}
    elif action == 'drain':
        if status in ('completed', 'failed'):
            state['drain_complete'] = payload.get('ready', True)
            state['drain_watermark'] = payload.get('watermark')
            if not state['drain_complete']:
                state['final'] = 'pending'
    elif action == 'edit':
        edit(state, payload, actor, status, now, canon)
    elif action == 'add':
        if status in ('completed', 'failed'):
            raise CorrectionConflict('Meeting state is read-only after meeting end')
        if payload.get('type') not in ITEM_TYPES or not isinstance(payload.get('text'), str) or not 0 < len(payload['text']) <= 3000:
            raise ValueError('Invalid new item')
        iid = str(uuid4())
        state['sequence'] += 1
        item = {'id': iid, 'type': payload['type'], 'text': payload['text'], 'status': {'agenda': 'pending', 'question': 'open'}.get(payload['type'], 'proposed'),
                'created_sequence': state['revision'] + 1,
                'details': details(payload.get('details', {})), 'evidence': [], 'revision': 1, 'human': True, 'last_editor': str(actor),
                'manual_fields': ['text', 'type', *['details.' + k for k in payload.get('details', {})]],
                'sequence': state['sequence'], 'provisional': False, 'stale': False, 'withdrawn': False,
                'provenance': {'origin': 'host', 'actor': str(actor)}}
        state['items'][iid] = item
        event(state, actor, 'add', {'item': item}, now)
        acknowledge_plan_only(state, canon, now)
    elif action == 'ingest-documents':
        ingest_documents(state, payload, actor, status, now)
    elif action == 'remove-source':
        if status in ('completed', 'failed'):
            raise CorrectionConflict('Meeting state is read-only after meeting end')
        if not permitted(state, actor, 'editors'):
            raise PermissionError('Source editing restricted by policy')
        source = state['documents'].get(payload.get('id'))
        if source is None:
            raise ValueError('Unknown document source')
        source.update(active=False, manual_removed=True)
        reconcile(state, canon, status, now)
        event(state, actor, 'remove_source', {'document_id': payload['id']}, now)
    elif action == 'vote':
        vote(state, payload, actor, owner, electorate, status, now)
    elif action == 'claim':
        return claim(state, canon, status, payload['role'], owner, now)
    elif action == 'validate':
        job = state['jobs'].get(payload.get('role'), {})
        by_id = sources(canon, state)
        valid = valid_job(state, payload, now) and all(key in by_id and source_key(by_id[key]) == fp for key, fp in job.get('source_keys', {}).items())
        if valid:
            job['admitted'] = True
        elif job.get('generation') == payload.get('generation') and not job.get('admitted'):
            job.update(status='pending', lease_until=0, attempts=0)
        return {'valid': valid}
    elif action == 'result':
        result = accept(state, canon, payload, electorate, now)
        if result.get('accepted') and payload.get('role') == 'publish' and payload.get('outcome') == 'published' and data.get('workspace_id'):
            doc = {'workspace': data['workspace_id'], 'path': f'wiki/meetings/{canon["meeting_id"]}/state.md', 'title': 'Meeting state', 'kind': 'meeting'}
            docs = data.setdefault('docs', [])
            if not any(d.get('workspace') == doc['workspace'] and d.get('path') == doc['path'] for d in docs):
                docs.append(doc)
        return result
    elif action == 'retry':
        retried = False
        for job in state['jobs'].values():
            if job['status'] == 'failed':
                job.update(status='pending', attempts=0, retry_at=0)
                retried = True
        if retried and status in ('completed', 'failed'):
            state['final'] = 'pending'
            state['last_reason_at'] = 0
    result = view(state, status, actor == owner, payload.get('archive_offset', 0) if action == 'state' else 0)
    validator('view').validate(result)
    return result


def audience_stamp(data, owner, roster=()):
    state = data.get('live_assist', {})
    return digest([data.get('workspace_id'), sorted(set([owner, *data.get('transcript_viewers', [])])), sorted(set(roster)), state.get('policy', BASELINE)])


def document_descriptors(state):
    return [{k: d.get(k) for k in ('document_id', 'sha256', 'path', 'manual_removed')} for d in state.get('documents', {}).values()]


def ingest_documents(state, payload, actor, status, now):
    if not state['enabled'] or status in ('completed', 'failed'):
        raise CorrectionConflict('Document research requires an enabled active/draft assistant')
    docs = payload.get('documents')
    if not isinstance(docs, list) or not 1 <= len(docs) <= 5:
        raise ValueError('Expected one to five document excerpts')
    for doc in docs:
        if (not isinstance(doc, dict) or not re.fullmatch(r'[a-f0-9]{64}', str(doc.get('document_id', '')))
                or not re.fullmatch(r'[a-f0-9]{64}', str(doc.get('sha256', '')))
                or not isinstance(doc.get('text'), str) or not 0 < len(doc['text']) <= 3000
                or not isinstance(doc.get('path'), str) or len(doc['path']) > 500
                or not isinstance(doc.get('workspace_id'), str)):
            raise ValueError('Invalid document excerpt')
    wanted = {d['document_id'] for d in docs}
    needed = max(0, len(set(state['documents']) | wanted) - 32)
    removable = [(key, doc) for key, doc in state['documents'].items() if not doc['active'] and key not in wanted]
    if needed > len(removable):
        raise ValueError('Meeting document source budget reached; remove unused sources first')
    for key, doc in removable[:needed]:
        event(state, 'system', 'source_archived', {'document': doc}, now)
        del state['documents'][key]
    for doc in docs:
        key = doc['document_id']
        state['documents'][key] = dict(doc, active=True, manual_removed=False)
        iid = digest(['research', key])
        if iid in state['items']:
            continue
        state['sequence'] += 1
        item = {'id': iid, 'type': 'evidence', 'text': doc['text'], 'status': 'proposed', 'details': {'source_status': 'accessible', 'epistemic_basis': 'reported'},
                'created_sequence': state['revision'] + 1,
                'evidence': [{'document_id': key, 'sha256': doc['sha256'], 'quote': doc['text']}], 'revision': 1,
                'sequence': state['sequence'], 'human': False, 'provisional': True, 'stale': False, 'withdrawn': False,
                'provenance': {'origin': 'user-requested-research', 'role': 'document-research', 'requested_by': str(actor)}}
        item['document_dependencies'] = [key]
        state['items'][iid] = item
        event(state, actor, 'document_research', {'item_id': iid, 'after': item}, now)


def render_markdown(state):
    """Final human-readable projection; no operator metadata or model-invented paths."""
    lines = ['# Meeting state', '', f"Finalization: {state['final']}", '', '## Goal', '', state['goal']['text'] if not state['goal'].get('hidden') else '[Source no longer shareable]',
             '', '## Meeting summary', '', state['summaries']['meeting'], '', '## Last discussion', '', state['summaries']['current']]
    if any(i.get('hidden') for i in state['items'].values()):
        lines.extend(['', 'Some unavailable or non-shareable document-derived content has been withheld.'])
    for kind in sorted(ITEM_TYPES):
        items = [i for i in state['items'].values() if i['type'] == kind and not i.get('withdrawn') and not i.get('stale') and not i.get('hidden')]
        if not items:
            continue
        lines.extend(['', '## ' + kind.replace('_', ' ').title(), ''])
        for item in sorted(items, key=lambda i: (i.get('created_sequence', i.get('sequence', 0)), i['id'])):
            lines.append(f"- **{item['status']}**: {item['text']}")
            for e in item['evidence']:
                if e.get('document_id'):
                    doc = state['documents'][e['document_id']]
                    lines.append(f"  - Document {doc['path']} (SHA-256 {doc['sha256']}): {e['quote']}")
                else:
                    lines.append(f"  - {e.get('speaker_name', 'Unknown')} at {e.get('start_ms', 0)/1000:g}s: {e['quote']}")
    return '\n'.join(lines) + '\n'
