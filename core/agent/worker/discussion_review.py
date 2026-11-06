"""Tool-less completion worker for an explicit post-meeting review request."""
import json
import logging
import os

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


def run(stream, out_topic, start):
    try:
        inline = start['entrypoint']['inline']
        if not inline.startswith(DISCUSSION_REVIEW_PREFIX):
            raise ValueError('Missing discussion review marker')
        payload = json.loads(inline[len(DISCUSSION_REVIEW_PREFIX):])
        if os.environ.get('TINA_CHAT_SESSION') != 'discussion-review-' + payload['request_id']:
            raise ValueError('Discussion request mismatch')
        prepared = json.loads(payload['text'])
        completion = completion_from_env(timeout=180)
        sources = {s['id']: {'id': s['id'], 'speaker': s['speaker_name'], 'text': s['quote']} for s in prepared['sources']}
        windows, history = [], []
        for window in prepared['windows']:
            current = list(window['source_ids'])
            current_aliases = {f't{index}': sid for index, sid in enumerate(current)}
            earlier_aliases = {f'h{index}': sid for index, sid in enumerate(history)}
            aliases = {**earlier_aliases, **current_aliases}
            prompt = {'agenda': prepared['agenda'], 'target_window': {'id': window['id'],
                'current_turns': [sources[sid] | {'id': alias} for alias, sid in current_aliases.items()],
                'earlier_turns': [sources[sid] | {'id': alias} for alias, sid in earlier_aliases.items()],
                'allowed_relevance_and_interaction_source_ids': list(current_aliases),
                'allowed_progress_source_ids': list(aliases)}}
            schema = window_classification_schema(window['id'], list(current_aliases), list(aliases))
            request_system = SYSTEM + (f' Classify only target window {window["id"]}; return one object in a one-item windows array. '
                'This request contains no future turns. Follow its enum-constrained local evidence aliases. Schema:\n'
                + json.dumps(schema, ensure_ascii=False))
            raw, result_window, failure = '', None, None
            for attempt in range(2):
                request_prompt = prompt
                if attempt:
                    correction = {
                        'validation_errors': [str(failure)],
                        'correction_instruction': 'Return only the target window. Correct the listed validation errors; every reason must be Vietnamese, with English technical terms allowed. Do not use Chinese, Japanese or Korean text.'}
                    if not (isinstance(failure, str) and 'CJK text' in failure):
                        correction['previous_invalid_output'] = raw[:5000]
                    request_prompt = prompt | correction
                result = completion.complete(json.dumps(request_prompt, ensure_ascii=False),
                                             system=request_system, response_schema=schema)
                raw = result.text
                if len(raw) > 10000:
                    failure = 'Discussion window result too large'
                    continue
                text = raw.strip()
                lines = text.splitlines()
                if len(lines) >= 3 and lines[0] in ('```json', '```') and lines[-1] == '```':
                    text = '\n'.join(lines[1:-1])
                try:
                    candidate = json.loads(text)
                    if len(candidate.get('windows', [])) != 1 or candidate['windows'][0].get('id') != window['id']:
                        raise ValueError('Missing or reordered target window')
                    result_window = candidate['windows'][0]
                    for task in ('relevance', 'interaction', 'progress'):
                        decision = result_window[task]
                        allowed = current_aliases if task != 'progress' else aliases
                        invalid_aliases = [alias for alias in decision['source_ids'] if alias not in allowed]
                        if invalid_aliases:
                            raise ValueError(f'{window["id"]}.{task}: invalid local evidence alias {invalid_aliases[:4]}')
                        decision['source_ids'] = [allowed[alias] for alias in decision['source_ids']]
                    result_window = validate_classification({'windows': [result_window]},
                        {'windows': [window]}, prior_source_ids=history)['windows'][0]
                    break
                except Exception as exc:
                    failure = _safe_failure(exc)
            if result_window is None:
                raise ValueError(failure or 'Invalid classification')
            windows.append(result_window)
            history.extend(current)
        classification = validate_classification({'windows': windows}, prepared)
        response = {'classification': classification, 'model': result.model or os.environ.get('TINA_LLM_MODEL') or completion.name}
        stream.xadd(out_topic, {'event': json.dumps({'type': 'message-delta', 'text': json.dumps(response, ensure_ascii=False)})})
    except Exception as exc:  # Never log transcript, prompts or provider responses.
        detail = _safe_failure(exc) if isinstance(exc, (ValueError, ValidationError)) else ''
        logging.getLogger(__name__).warning('discussion review failed error=%s detail=%s', type(exc).__name__, detail)
    stream.xadd(out_topic, {'event': json.dumps({'type': 'turn-complete'})})
    stream.expire(out_topic, 300)
