"""Tool-less readable notes from an immutable canonical window; Meeting API approves the result."""
import json
import os
import hashlib

from shared.agent_config import load_meeting_config
from shared.units import CANONICAL_NOTES_PREFIX
from worker.meeting import meeting_card_turn, build_card_prompt


def run(stream, work, inline, *, completion=None):
    job = json.loads(inline[len(CANONICAL_NOTES_PREFIX):])
    owner = os.environ.get("TINA_OWNER", "")
    if not owner or str(job.get("user_id")) != owner:
        raise ValueError("canonical notes owner does not match worker owner")
    source = job['source']
    evidence = source['evidence']
    cfg = load_meeting_config(work)
    result = {k: job[k] for k in ('meeting_id', 'user_id', 'source')}
    result['params'] = {'provider': os.environ.get('TINA_LLM_PROVIDER'), 'model': cfg.model,
                        'pipeline': 'canonical-readable', 'version': 2, 'prompt_version': 1}
    segments = [{'segment_id': e['segment_id'], 'text': e['quote'], 'speaker': e['speaker_name'],
                 'start': e['start_ms']/1000, 'rewrite_pass': 1} for e in evidence]
    lines = '\n'.join(f"[pass 1/3 id={s['segment_id']} speaker={s['speaker']}] {s['text']}" for s in segments)
    prompt = build_card_prompt(lines, cfg.card_kinds, cfg.steering,
                              polish_rules=cfg.polish_rules, tag_rules=cfg.tag_rules)
    result['params']['prompt_sha256'] = hashlib.sha256(prompt.encode()).hexdigest()
    notes = {e['segment_id']: {'id': e['segment_id'], 'text': e['quote']} for e in evidence}
    cards = []
    try:
        if not cfg.enabled:
            raise ValueError('workspace_processing_disabled')
        allow_fallback_retry = os.environ.get('TINA_ALLOW_FALLBACK_RETRY') == '1'
        for event in meeting_card_turn(work, segments, model=cfg.model, card_kinds=cfg.card_kinds,
                steering=cfg.steering, polish_rules=cfg.polish_rules, tag_rules=cfg.tag_rules,
                completion=completion, raise_on_fallback_error=allow_fallback_retry):
            if event.get('type') in ('model-error', 'auth-error'):
                raise RuntimeError('model_unavailable')
            if event.get('type') == 'note' and event.get('note', {}).get('id') in notes:
                notes[event['note']['id']] = event['note']
            if event.get('type') == 'card':
                cards.append(event['card'])
        result['notes'] = list(notes.values())
        result['cards'] = cards
    except Exception as exc:
        from llm.errors import emit_provider_fallback_marker, provider_fallback_reason
        if os.environ.get('TINA_ALLOW_FALLBACK_RETRY') == '1' and provider_fallback_reason(exc):
            emit_provider_fallback_marker(exc)
            raise
        # Do not publish provider error bodies or source text into logs/diagnostics.
        result['error'] = type(exc).__name__
    stream.xadd('canonical_notes_results', {'payload': json.dumps(result, ensure_ascii=False)})
    return result
