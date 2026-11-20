"""Tool-less completion worker for an explicit post-meeting review request."""
import itertools
import json
import logging
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait

from jsonschema import ValidationError
from llm import completion_from_env
from shared.discussion_review import SYSTEM, validate_classification, window_classification_schema
from shared.units import DISCUSSION_REVIEW_PREFIX


def _safe_failure(exc):
    if isinstance(exc, ValidationError):
        path = '.'.join(str(part) for part in exc.absolute_path)
        return f'schema {path or "root"} {exc.validator}'
    if isinstance(exc, (ValueError, KeyError, TypeError)):
        return str(exc)[:200]
    return type(exc).__name__


def _window_request(prepared, window, history, sources):
    current_aliases = {f't{index}': sid for index, sid in enumerate(window['source_ids'])}
    earlier_aliases = {f'h{index}': sid for index, sid in enumerate(history)}
    aliases = {**earlier_aliases, **current_aliases}
    prompt = {'agenda': prepared['agenda'], 'target_window': {'id': window['id'],
        'current_turns': [sources[sid] | {'id': alias} for alias, sid in current_aliases.items()],
        'earlier_turns': [sources[sid] | {'id': alias} for alias, sid in earlier_aliases.items()],
        'allowed_relevance_and_interaction_source_ids': list(current_aliases),
        'allowed_progress_source_ids': list(aliases)}}
    schema = window_classification_schema(window['id'], list(current_aliases), list(aliases))
    system = SYSTEM + (f' Classify only target window {window["id"]}; return one object in a one-item windows array. '
        'This request contains no future turns. Follow its enum-constrained local evidence aliases. Schema:\n'
        + json.dumps(schema, ensure_ascii=False))
    return prompt, schema, system, {window['id']: (current_aliases, aliases)}


def _batch_request(prepared, targets, history, sources):
    # One source table, with window-qualified aliases shared across batch targets.
    owner_aliases = {sid: f'{w["id"]}_t{i}' for w in prepared['windows']
                     for i, sid in enumerate(w['source_ids'])}
    prior, mappings, schemas, target_rows = list(history), {}, [], []
    for window in targets:
        current = {owner_aliases[sid]: sid for sid in window['source_ids']}
        allowed = {owner_aliases[sid]: sid for sid in [*prior, *window['source_ids']]}
        mappings[window['id']] = (current, allowed)
        schemas.append(window_classification_schema(window['id'], list(current), list(allowed))['properties']['windows']['items'])
        target_rows.append({'id': window['id'], 'current_source_ids': list(current),
                            'allowed_progress_source_ids': list(allowed)})
        prior.extend(window['source_ids'])
    schema = {'type': 'object', 'additionalProperties': False, 'required': ['windows'], 'properties': {
        'windows': {'type': 'array', 'minItems': len(targets), 'maxItems': len(targets),
                    'items': {'anyOf': schemas}}}}
    prompt = {'agenda': prepared['agenda'], 'target_windows': target_rows,
              'sources': [sources[sid] | {'id': owner_aliases[sid]} for sid in prior]}
    system = SYSTEM.replace(
        'Evidence IDs in the prompt are local aliases: t0, t1, ... for current turns and h0, h1, ... for\nearlier turns.',
        'Evidence IDs are window-qualified aliases such as w0_t0; use each target\'s allowed IDs.')
    system += (' Experimental retrospective batch: later target turns ARE visible. For each target, '
               'ignore later turns; relevance/interaction cite only current_source_ids; progress uses '
               'allowed_progress_source_ids and must cite the current target. Return exactly the requested '
               'target_windows, once each. Schema:\n' + json.dumps(schema, ensure_ascii=False))
    return prompt, schema, system, mappings


def _classify_group(completion, prepared, targets, history, sources, *, batched=False):
    if batched:
        prompt, schema, system, mappings = _batch_request(prepared, targets, history, sources)
    else:
        prompt, schema, system, mappings = _window_request(prepared, targets[0], history, sources)
    failure, raw = None, ''
    for attempt in range(2):
        request_prompt = prompt
        if attempt:
            correction = {'validation_errors': [str(failure)], 'correction_instruction':
                ('Return all requested target windows.' if batched else 'Return only the target window.')
                + ' Correct the listed validation errors; every reason must be Vietnamese, with English technical terms allowed. Do not use Chinese, Japanese or Korean text.'}
            if not (isinstance(failure, str) and 'CJK text' in failure):
                correction['previous_invalid_output'] = raw[:5000]
            request_prompt = prompt | correction
        result = completion.complete(json.dumps(request_prompt, ensure_ascii=False), system=system, response_schema=schema)
        raw = result.text
        if len(raw) > 10000 * len(targets):
            failure = 'Discussion window result too large'
            continue
        text = raw.strip()
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0] in ('```json', '```') and lines[-1] == '```':
            text = '\n'.join(lines[1:-1])
        try:
            candidate = json.loads(text)
            ids = [w['id'] for w in candidate['windows']]
            expected = [w['id'] for w in targets]
            if len(ids) != len(expected) or set(ids) != set(expected):
                raise ValueError('Missing, duplicate or unexpected target windows')
            by_id = {w['id']: w for w in candidate['windows']}
            windows = [by_id[wid] for wid in expected]
            for window in windows:
                current_aliases, aliases = mappings[window['id']]
                for task in ('relevance', 'interaction', 'progress'):
                    decision = window[task]
                    allowed = current_aliases if task != 'progress' else aliases
                    if any(alias not in allowed for alias in decision['source_ids']):
                        raise ValueError(f'{window["id"]}.{task}: invalid local evidence alias')
                    decision['source_ids'] = [allowed[alias] for alias in decision['source_ids']]
            # Never accept a candidate until all evidence and coverage checks pass.
            classified = validate_classification(candidate | {'windows': windows},
                {'windows': targets}, prior_source_ids=history)
            model = result.model or os.environ.get('TINA_LLM_MODEL') or completion.name
            return classified['windows'], model
        except (ValueError, KeyError, TypeError, ValidationError) as exc:
            failure = _safe_failure(exc)
    raise ValueError(failure or 'Invalid classification')


def classify(prepared, *, strategy='sequential', workers=2, batch_size=2, completion_factory=None):
    """Experimental strategies are callable by benchmarks only; run() uses sequential."""
    if strategy not in ('sequential', 'concurrent', 'batch'):
        raise ValueError('Unknown review strategy')
    if workers not in (1, 2) or batch_size not in (1, 2, 4):
        raise ValueError('Review experiments support 1–2 workers and batch sizes 1, 2 or 4')
    factory = completion_factory or (lambda: completion_from_env(timeout=180))
    sources = {s['id']: {'id': s['id'], 'speaker': s['speaker_name'], 'text': s['quote']} for s in prepared['sources']}
    size = batch_size if strategy == 'batch' else 1
    groups, history = [], []
    for index in range(0, len(prepared['windows']), size):
        targets = prepared['windows'][index:index + size]
        groups.append((targets, tuple(history)))
        history.extend(sid for w in targets for sid in w['source_ids'])
    results = {}
    if strategy == 'concurrent':
        def task(group):
            targets, prior = group
            return _classify_group(factory(), prepared, targets, prior, sources)
        pool = ThreadPoolExecutor(max_workers=workers)
        pending, next_group = {}, iter(enumerate(groups))
        try:
            for index, group in itertools.islice(next_group, workers):
                pending[pool.submit(task, group)] = index
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for future in done:
                    results[pending.pop(future)] = future.result()
                for index, group in itertools.islice(next_group, len(done)):
                    pending[pool.submit(task, group)] = index
        finally:
            for future in pending:
                future.cancel()
            pool.shutdown(wait=True, cancel_futures=True)
    else:
        completion = factory()
        for index, (targets, prior) in enumerate(groups):
            results[index] = _classify_group(completion, prepared, targets, prior, sources, batched=strategy == 'batch')
    ordered = [results[index] for index in range(len(groups))]
    if len({model for _, model in ordered}) != 1:
        raise ValueError('Review model changed between calls')
    classification = validate_classification({'windows': [w for windows, _ in ordered for w in windows]}, prepared)
    return {'classification': classification, 'model': ordered[0][1]}


def run(stream, out_topic, start):
    try:
        inline = start['entrypoint']['inline']
        if not inline.startswith(DISCUSSION_REVIEW_PREFIX):
            raise ValueError('Missing discussion review marker')
        payload = json.loads(inline[len(DISCUSSION_REVIEW_PREFIX):])
        if os.environ.get('TINA_CHAT_SESSION') != 'discussion-review-' + payload['request_id']:
            raise ValueError('Discussion request mismatch')
        prepared = json.loads(payload['text'])
        response = classify(prepared)
        stream.xadd(out_topic, {'event': json.dumps({'type': 'message-delta', 'text': json.dumps(response, ensure_ascii=False)})})
    except Exception as exc:  # Never log transcript, prompts or provider responses.
        detail = _safe_failure(exc) if isinstance(exc, (ValueError, ValidationError)) else ''
        logging.getLogger(__name__).warning('discussion review failed error=%s detail=%s', type(exc).__name__, detail)
    stream.xadd(out_topic, {'event': json.dumps({'type': 'turn-complete'})})
    stream.expire(out_topic, 300)
