"""Offline full-review experiments. Never calls the app or publishes workspace reports."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import threading
import time

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from llm.openai_compat import OpenAICompatCompletion
from shared.discussion_review import RUBRIC, prepare, validate_report
from worker.discussion_review import classify


class RecordingTransport(httpx.BaseTransport):
    def __init__(self, calls, lock, started, temperature):
        self.transport = httpx.HTTPTransport()
        self.calls, self.lock, self.started = calls, lock, started
        self.temperature = temperature

    def handle_request(self, request):
        body = json.loads(request.content)
        if self.temperature is not None:
            body['temperature'] = self.temperature
        content = json.dumps(body, ensure_ascii=False).encode()
        headers = dict(request.headers)
        headers['content-length'] = str(len(content))
        request = httpx.Request(request.method, request.url, headers=headers,
                               content=content, extensions=request.extensions)
        prompt = json.loads(body['messages'][-1]['content'])
        targets = prompt.get('target_windows') or [prompt['target_window']]
        start = time.perf_counter()
        entry = {'window_ids': [w['id'] for w in targets], 'correction': 'validation_errors' in prompt,
                 'submitted_seconds': start - self.started,
                 'prompt_characters': sum(len(m['content']) for m in body['messages'])}
        try:
            response = self.transport.handle_request(request)
            response.read()
            entry['status'] = response.status_code
            if response.status_code == 200:
                value = response.json()
                entry['usage'] = value.get('usage')
                choice = (value.get('choices') or [{}])[0]
                entry['finish_reason'] = choice.get('finish_reason')
            return response
        except Exception as exc:
            entry['error_type'] = type(exc).__name__
            raise
        finally:
            entry['wall_seconds'] = time.perf_counter() - start
            with self.lock:
                self.calls.append(entry)

    def close(self):
        self.transport.close()


def run_once(prepared, mode, base_url, model, temperature):
    calls, transports = [], []
    lock = threading.Lock()
    started = time.perf_counter()
    def factory():
        transport = RecordingTransport(calls, lock, started, temperature)
        with lock:
            transports.append(transport)
        return OpenAICompatCompletion(base_url=base_url.rstrip('/') + '/v1', model=model,
                                      timeout=180, transport=transport)
    strategy = 'batch' if mode.startswith('batch') else mode
    record = {'mode': mode}
    try:
        result = classify(prepared, strategy=strategy, workers=2,
                          batch_size=int(mode[-1]) if mode.startswith('batch') else 2,
                          completion_factory=factory)
        validate_report(dict(version='discussion-review.v1', id='0' * 32, meeting_id=1,
            agenda=prepared['agenda'], canonical_revision=1, source_revision='0' * 64,
            rubric=RUBRIC, created_at='2026-11-06T00:00:00Z', model=result['model'],
            windows=result['classification']['windows'], sources=prepared['sources']))
        record.update(valid=True, result=result)
    except Exception as exc:
        # Exception messages can contain provider output; retain only type, never prompts/responses.
        record.update(valid=False, error_type=type(exc).__name__)
    finally:
        record['wall_seconds'] = time.perf_counter() - started
        for transport in transports:
            transport.close()
    record['calls'] = sorted(calls, key=lambda c: c['submitted_seconds'])
    record['corrections'] = sum(c['correction'] for c in calls)
    record['truncated_calls'] = sum(c.get('finish_reason') == 'length' for c in calls)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=Path(__file__).resolve().parents[1] / 'tests/fixtures/discussion_review_benchmark.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base-url', default='http://localhost:11435')
    parser.add_argument('--model', default='qwen2.5:7b-instruct')
    parser.add_argument('--runs', type=int, default=10)
    parser.add_argument('--modes', nargs='+', choices=['sequential', 'concurrent', 'batch2', 'batch4'],
                        default=['sequential', 'concurrent', 'batch2', 'batch4'])
    parser.add_argument('--parallel-slots', type=int, choices=[1, 2], required=True,
                        help='Record the server configuration; does not change Ollama.')
    parser.add_argument('--temperature', type=float, help='Omit to use the same server default as the app.')
    parser.add_argument('--max-tokens', type=int, default=1200)
    parser.add_argument('--repeat-transcript', type=int, default=1)
    args = parser.parse_args()
    if args.runs < 1 or args.repeat_transcript < 1 or args.max_tokens < 1:
        parser.error('runs, repeat-transcript and max-tokens must be positive')
    data = json.loads(args.input.read_text(encoding='utf-8'))
    if args.repeat_transcript > 1:
        original = data['canonical']['segments']
        span = max(s['end_ms'] for s in original) - min(s['start_ms'] for s in original) + 70000
        data['canonical']['segments'] = [dict(s, segment_id=f'{s["segment_id"]}/repeat{repeat}',
            start_ms=s['start_ms'] + repeat * span, end_ms=s['end_ms'] + repeat * span)
            for repeat in range(args.repeat_transcript) for s in original]
    prepared = prepare(data['canonical'], data['agenda'])
    os.environ['TINA_LLM_MAX_TOKENS'] = str(args.max_tokens)
    with httpx.Client(timeout=600) as client:
        version = client.get(args.base_url.rstrip('/') + '/api/version').json()
        tags = client.get(args.base_url.rstrip('/') + '/api/tags').json()
        started = time.perf_counter()
        warm = client.post(args.base_url.rstrip('/') + '/api/generate', json={
            'model': args.model, 'prompt': 'Reply OK.', 'stream': False,
            'options': {'num_predict': 1, **({'temperature': args.temperature} if args.temperature is not None else {})},
            'keep_alive': '30m'})
        warm.raise_for_status()
        warm_seconds = time.perf_counter() - started
        residency = client.get(args.base_url.rstrip('/') + '/api/ps').json()
    output = {'rubric': RUBRIC, 'started_at': datetime.now(timezone.utc).isoformat(),
              'input_sha256': hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
              'model': args.model, 'server': version, 'models': tags, 'warm_seconds': warm_seconds,
              'residency': residency, 'parallel_slots': args.parallel_slots, 'temperature': args.temperature,
              'max_tokens': args.max_tokens, 'windows': len(prepared['windows']),
              'fixture_check_count': len(data.get('checks', [])), 'runs': [], 'summary': {}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for repeat in range(args.runs):
        # Rotate ordering across repetitions; never run benchmark conditions simultaneously.
        offset = repeat % len(args.modes)
        for mode in args.modes[offset:] + args.modes[:offset]:
            record = run_once(prepared, mode, args.base_url, args.model, args.temperature)
            record['repeat'] = repeat + 1
            if record['valid']:
                windows = {w['id']: w for w in record['result']['classification']['windows']}
                record['fixture_checks'] = [
                    (check['label'] in windows[check['window']][check['task']]['labels']
                     if check['task'] == 'interaction' else windows[check['window']][check['task']]['label'] == check['label'])
                    for check in data.get('checks', [])]
            output['runs'].append(record)
            for name in args.modes:
                samples = [r for r in output['runs'] if r['mode'] == name]
                if not samples:
                    continue
                valid = [r for r in samples if r['valid']]
                output['summary'][name] = {
                    'samples': len(samples), 'valid': len(valid),
                    'median_all_seconds': statistics.median(r['wall_seconds'] for r in samples),
                    'median_valid_seconds': statistics.median(r['wall_seconds'] for r in valid) if valid else None,
                    'range_seconds': [min(r['wall_seconds'] for r in samples), max(r['wall_seconds'] for r in samples)],
                    'corrections': sum(r['corrections'] for r in samples),
                    'truncated_calls': sum(r['truncated_calls'] for r in samples),
                    'all_fixture_checks_passed': sum(bool(r.get('fixture_checks')) and all(r['fixture_checks']) for r in valid)}
            args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps({k: record[k] for k in ('mode', 'repeat', 'valid', 'wall_seconds', 'corrections', 'truncated_calls')})
                  + ' checks=' + str(record.get('fixture_checks', [])), flush=True)
    with httpx.Client(timeout=30) as client:
        output['final_residency'] = client.get(args.base_url.rstrip('/') + '/api/ps').json()
    output['finished_at'] = datetime.now(timezone.utc).isoformat()
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(output['summary'], indent=2), flush=True)


if __name__ == '__main__':
    main()
