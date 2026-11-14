"""Synthetic voice regression through the real control-plane and worker, without live meeting data."""
import argparse
import json
import os
from pathlib import Path
import tempfile
import time
import unicodedata
import hashlib

from report import compare_reports, delivery_signals, latency_report, stage_report, runtime_results, write_markdown

from fastapi import FastAPI
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader
from shared.meeting_knowledge import PREFIX, sources_for
from shared import voice_knowledge as voice
from shared.voice_knowledge import voice_route
from worker.engine import _run_meeting_knowledge
from shared.voice_trace import voice_trace_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Call the configured LLM using only synthetic fixtures')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cases', help='Comma-separated case IDs; default: all')
    parser.add_argument('--prompt-file', type=Path, help='Override only voice wording for a controlled comparison')
    parser.add_argument('--label', default='current')
    parser.add_argument('--suite', choices=['questions', 'conversations'], default='questions')
    parser.add_argument('--runtime-report', type=Path, help='JUnit XML from the bot meeting-voice tests')
    parser.add_argument('--timing-log', type=Path, help='Bot log containing voice_timing JSON events')
    parser.add_argument('--stage-log', type=Path, help='Combined local logs containing voice_stage JSON spans')
    parser.add_argument('--baseline', type=Path, help='Previous JSON report from the same suite and execution mode')
    args = parser.parse_args()
    if args.output.suffix != '.json':
        parser.error('--output must end in .json; the Markdown report is written beside it')
    if args.prompt_file:
        baseline = args.prompt_file.read_text()
        voice.VOICE_REPAIR_SYSTEM = baseline + voice.VOICE_REPAIR_SYSTEM[len(voice.VOICE_SYSTEM):]
        voice.VOICE_FORMAT_SYSTEM = baseline + voice.VOICE_FORMAT_SYSTEM[len(voice.VOICE_SYSTEM):]
        voice.VOICE_SYSTEM = baseline
    fixture_path = Path(__file__).with_name(args.suite + '.json')
    fixture_bytes = fixture_path.read_bytes()
    fixture = json.loads(fixture_bytes)
    runtime = runtime_results(args.runtime_report) if args.runtime_report else {}
    if args.cases:
        ids = {int(value) for value in args.cases.split(',')}
        if ids - {c['id'] for c in fixture['cases']}: parser.error('Unknown case ID')
        fixture['cases'] = [c for c in fixture['cases'] if c['id'] in ids]
    results = []
    now = int(time.time() * 1000)
    with tempfile.TemporaryDirectory(prefix='tina-voice-eval-') as directory:
        root = (Path(directory) / '7').resolve(); root.mkdir()
        for name, content in fixture['documents'].items():
            path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
        canonical = {'segments': [s | {'revision': 0, 'start_ms': now+s['offset_ms']-500,
                                      'end_ms': now+s['offset_ms']} for s in fixture['segments']]}
        current_sources = voice.voice_chunks(sources_for(canonical, fixture['documents']))
        row = {'id': 1, 'user_id': 7, 'status': 'active', 'platform': 'google_meet', 'native_meeting_id': 'synthetic',
               'data': {'docs': [{'path': p} for p in fixture['documents']], 'voice_assistant': {
                   'enabled': True, 'revision': 1, 'include_transcript': True, 'documents': list(fixture['documents']),
                   'allow_general_knowledge': True, 'allow_web_search': True}}}
        api.meeting_get = lambda base, subject, mid, path: canonical if path.endswith('/canonical') else row
        os.environ['TINA_INTERNAL_API_SECRET'] = 'synthetic-eval-only'
        os.environ['TINA_CHAT_SESSION'] = 'meeting-knowledge-synthetic-eval'
        class Stream:
            def __init__(self): self.text = []
            def xadd(self, topic, fields):
                event = json.loads(fields['event'])
                if event.get('type') == 'message-delta': self.text.append(event['text'])
            def expire(self, *args): pass
        def complete(request, text):
            stream = Stream()
            _run_meeting_knowledge(stream, 'synthetic-output', {'entrypoint': {'inline': PREFIX+json.dumps({
                'request_id': 'synthetic-eval', 'voice_trace_id': voice_trace_id.get(), 'text': text})}})
            return ''.join(stream.text)
        app = FastAPI()
        api.register(app, lambda r: '7', lambda r, slug: root, WorkspaceReader(directory), 'http://synthetic', complete)
        client = TestClient(app)
        normalize = lambda s: unicodedata.normalize('NFKC', s).casefold()
        for case in fixture['cases']:
            if case.get('layer') == 'runtime':
                verdict = runtime.get(case['runtime_test'], 'not_run')
                result = {'id': case['id'], 'title': case['title'], 'runtime_test': case['runtime_test'],
                          'evaluated_layer': 'bot-runtime-test', 'status': verdict,
                          'passed': verdict == 'passed' if args.runtime_report else None,
                          'review_focus': case['review_focus']}
                results.append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
                continue
            started = time.monotonic()
            result = {'id': case['id'], 'title': case.get('title', case['question']), 'question': case['question'],
                      'route_correct': voice_route(case['question'])[0] == case['mode'],
                      'evaluated_layer': 'live-answer-service' if args.live else 'routing-only'}
            if args.live:
                history = []
                for turn in case.get('history', []):
                    refs = [{'key': s['key'], 'fingerprint': s['fingerprint']} for s in current_sources
                            if s.get('segment_id') in turn['segment_ids']]
                    history.append({k: turn[k] for k in ('question', 'answer')} | {
                        'sources': refs, 'created_at_ms': now - 1000,
                        **({'clarification': True} if turn.get('clarification') else {})})
                response = client.post('/api/internal/meeting-voice/1/answer', headers={
                    'X-Internal-Secret': 'synthetic-eval-only', 'X-User-Id': '7'}, json={'question': case['question'], 'revision': 1, 'history': history})
                body = response.json()
                result.update(http_status=response.status_code, reason=body.get('reason'), text=body.get('text'),
                              service_available=body.get('reason') not in ('llm_unavailable', 'verification_unavailable', 'web_unavailable'),
                              lookups=body.get('lookups', []), links=body.get('links', []),
                              verification=body.get('verification', []),
                              source_count=len(body.get('sources', [])),
                              review_focus=case.get('review_focus', ''),
                              delivery_signals=delivery_signals(body.get('text') or ''),
                              human_ratings={'naturalness_1_to_5': None, 'correctness_1_to_5': None,
                                             'clarification_1_to_5': None, 'acknowledgment_1_to_5': None})
                if case['expected_terms']:
                    result['expected_terms_present'] = all(normalize(t) in normalize(body.get('text', '')) for t in case['expected_terms'])
                    result['has_evidence'] = bool(body.get('sources'))
                elif case.get('expect_evidence') is False:
                    result['no_unsupported_answer'] = body.get('reason') != 'answered'
                if case.get('expected_reasons'):
                    result['expected_reason_present'] = body.get('reason') in case['expected_reasons']
            result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
            result['passed'] = result['route_correct'] and (not args.live or response.status_code == 200 and result['service_available'])
            if args.live and case['mode'] == 'meeting':
                result['passed'] = result['passed'] and (
                    result.get('expected_terms_present', True) and result.get('has_evidence', True)
                    and result.get('no_unsupported_answer', True) and result.get('expected_reason_present', True))
            result['status'] = ('live_smoke_passed' if args.live else 'routing_passed') if result['passed'] else 'failed'
            results.append(result)
            print(json.dumps({k: v for k, v in result.items() if k not in ('text', 'links')}, ensure_ascii=False), flush=True)
    report = {'label': args.label, 'kind': fixture['kind'], 'fixture': hashlib.sha256(fixture_bytes).hexdigest(),
              'prompt_sha256': hashlib.sha256(voice.VOICE_SYSTEM.encode()).hexdigest(),
              'completion_config': {'provider': os.environ.get('TINA_LLM_PROVIDER') or 'openai-compat',
                                    'model': os.environ.get('TINA_LLM_MODEL') or None},
              'live_llm': args.live, 'cases': results,
              'note': 'Term checks are a smoke signal, not human-rated semantic correctness or a real Vietnamese meeting benchmark.'}
    if args.timing_log:
        report['playback_latency'] = latency_report(args.timing_log)
    if args.stage_log:
        report['stage_timings'] = stage_report(args.stage_log)
    if args.baseline:
        report['comparison'] = compare_reports(report, json.loads(args.baseline.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    write_markdown(report, args.output.with_suffix('.md'))
    if any(r['passed'] is False for r in results): raise SystemExit(1)


if __name__ == '__main__': main()
