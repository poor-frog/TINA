"""Local evaluation evidence; automatic checks never imply human listening scores."""
import json
import math
import re
from pathlib import Path
from statistics import median
from xml.etree import ElementTree
from uuid import UUID


def stage_report(path):
    """Aggregate local content-free spans; inclusive parent times must not be summed with children."""
    allowed = {'agent', 'answer', 'plan', 'source_selection', 'semantic_retrieval', 'generation',
               'verify', 'repair', 'format_repair', 'rerank', 'web_search', 'task_flow', 'decision_flow',
               'rag_total', 'rag_plan', 'rag_answer', 'rag_lookup_batch', 'rag_assess'}
    tools = {'get_recent_transcript', 'search_meeting', 'search_shared_meetings', 'search_shared_documents',
             'read_source_context', 'search_web', 'draft_task', 'draft_decision', 'search_approved_actions',
             'calculate', 'open_source'}
    allowed |= {'rag_lookup:' + name for name in tools}
    turns, seen, skipped = {}, set(), 0
    for line in Path(path).open():
        start = line.find('{')
        if start < 0: continue
        try:
            event = json.loads(line[start:])
            if not isinstance(event, dict) or event.get('type') != 'voice_stage': continue
            identifier = str(UUID(str(event.get('request_id'))))
            span = str(UUID(str(event['span_id']))) if 'span_id' in event else None
        except (ValueError, TypeError, AttributeError): continue
        stage, elapsed, status = event.get('stage'), event.get('elapsed_ms'), event.get('status')
        if (not isinstance(stage, str) or stage not in allowed or status not in ('ok', 'error', 'cancelled')
                or type(elapsed) not in (int, float) or not math.isfinite(elapsed) or elapsed < 0): continue
        if span and span in seen: continue
        if identifier not in turns and len(turns) >= 1000 or len(turns.get(identifier, [])) >= 64:
            skipped += 1; continue
        if span: seen.add(span)
        row = {'stage': stage, 'elapsed_ms': elapsed, 'status': status}
        if type(event.get('round')) is int and event['round'] in (1, 2): row['round'] = event['round']
        if type(event.get('tool_count')) is int and event['tool_count'] in (1, 2): row['tool_count'] = event['tool_count']
        if type(event.get('parallel')) is bool: row['parallel'] = event['parallel']
        if event.get('lookup_outcome') in ('found', 'empty', 'unavailable', 'partial', 'access_changed'):
            row['lookup_outcome'] = event['lookup_outcome']
        if event.get('outcome') in ('applied','empty','fallback','skipped'): row['outcome'] = event['outcome']
        for key in ('input_sources', 'output_sources'):
            if type(event.get(key)) is int and event[key] >= 0: row[key] = event[key]
        turns.setdefault(identifier, []).append(row)
    groups = {}
    for rows in turns.values():
        for row in rows: groups.setdefault(row['stage'], []).append(row)
    stages = {}
    for stage, rows in sorted(groups.items()):
        values = sorted(row['elapsed_ms'] for row in rows)
        stages[stage] = {'n': len(rows), 'p50_ms': median(values), 'p95_ms': values[math.ceil(.95*len(values))-1],
                         'errors': sum(row['status'] == 'error' for row in rows),
                         'cancelled': sum(row['status'] == 'cancelled' for row in rows)}
        outcomes = {outcome:sum(row.get('outcome')==outcome for row in rows)
                    for outcome in ('applied','empty','fallback','skipped')}
        if any(outcomes.values()): stages[stage]['outcomes'] = {key:n for key,n in outcomes.items() if n}
    return {'observed_turns': len(turns), 'stages': stages, 'turns': turns, 'omitted_spans': skipped,
            'note': 'Inclusive stage times overlap; do not sum graph/API totals with model/tool spans. Missing stages are unmeasured, not zero. Legacy spans without span_id are not deduplicated.'}


def runtime_results(path):
    root = ElementTree.parse(path).getroot()
    results = {}
    for case in root.iter('testcase'):
        name = case.get('name')
        if name in results:
            raise ValueError(f'Duplicate runtime test: {name}')
        results[name] = ('failed' if case.find('failure') is not None or case.find('error') is not None
                         else 'not_run' if case.find('skipped') is not None else 'passed')
    return results


def latency_report(path):
    # Logs may contain private transcripts. Copy only numeric allowlisted timing fields.
    metrics = ('answer_playback_after_end', 'answer_pcm_after_end', 'answer_service',
               'question_ready_after_end', 'asr_request', 'ack_after_question', 'notice_after_question')
    turns = {}
    for line in Path(path).open():
        start = line.find('{')
        if start < 0:
            continue
        try:
            event = json.loads(line[start:])
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get('type') != 'voice_timing':
            continue
        key = event.get('request_id')
        durations = event.get('durations_ms')
        if not isinstance(key, str) or not key or len(key) > 128 or not isinstance(durations, dict):
            continue
        turn = turns.setdefault(key, {})
        for name in metrics:
            value = durations.get(name)
            if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                turn[name] = value
        if event.get('stage') == 'turn_finished':
            turn['completed'] = event.get('outcome') in ('completed', 'clarification', 'no_evidence')
    def summary(rows):
        result = {}
        for name in metrics:
            values = sorted(row[name] for row in rows if name in row)
            if values:
                result[name] = {'n': len(values), 'p50_ms': median(values),
                                'p95_ms': values[math.ceil(.95 * len(values))-1]}
        return result
    return {'observed_turns': len(turns), 'completed_turns': sum(row.get('completed', False) for row in turns.values()),
            'all_observed': summary(turns.values()),
            'completed': summary([row for row in turns.values() if row.get('completed')]),
            'note': 'Bot timestamps; answer, acknowledgment and notice playback are separate. Not a human-perceived latency score.'}


def delivery_signals(text):
    value = text.strip()
    return {'word_count': len(value.split()), 'question_count': value.count('?'),
            'acknowledgment_opening': bool(re.match(r'^(dạ[, ]+em nghe|em đây|đợi em|chờ em)', value, re.I)),
            'report_opening': bool(re.match(r'^(dựa trên|sau đây là|theo các thông tin được cung cấp)', value, re.I)),
            'note': 'Review hints only; word count and phrase matches are not naturalness grades.'}


def compare_reports(current, baseline):
    if current.get('fixture') != baseline.get('fixture') or current.get('live_llm') != baseline.get('live_llm'):
        raise ValueError('Compare the same fixture and execution mode')
    if current.get('completion_config') != baseline.get('completion_config'):
        raise ValueError('Compare the same completion provider and model')
    old = {row['id']: row for row in baseline['cases']}
    pairs = []
    for row in current['cases']:
        previous = old.get(row['id'])
        if previous is None:
            raise ValueError('Comparison case IDs differ')
        if row.get('question') != previous.get('question'):
            raise ValueError('Comparison questions differ')
        pairs.append({'id': row['id'], 'before_status': previous.get('status'), 'after_status': row.get('status'),
                      'before_text': previous.get('text'), 'after_text': row.get('text'),
                      'before_answer_service_ms': previous.get('elapsed_ms') if 'text' in previous else None,
                      'after_answer_service_ms': row.get('elapsed_ms') if 'text' in row else None})
    if len(old) != len(pairs):
        raise ValueError('Comparison case IDs differ')
    return {'baseline_label': baseline.get('label'), 'pairs': pairs,
            'note': 'Confirm the same provider/model, source fixture and voice before interpreting A/B results. No automatic naturalness winner.'}


def write_markdown(report, output):
    def cell(value):
        return str(value or '—').replace('|', '\\|').replace('\n', ' ')
    lines = ['# TINA Vietnamese conversation evaluation', '',
             f"Run: {report['label']}. Live LLM: {report['live_llm']}.", '',
             'Runtime tests use synthetic audio/events; route-only checks do not evaluate LLM wording or speech quality.', '',
             '| Case | Scenario | Checked | Result |', '|---|---|---|---|']
    for row in report['cases']:
        lines.append(f"| {row['id']} | {cell(row.get('title', row.get('question')))} | {cell(row.get('evaluated_layer'))} | {cell(row.get('status'))} |")
    lines += ['', '## Human review', '',
              'Rate correctness, naturalness, helpful clarification and acknowledgment appropriateness from 1–5. Leave fields blank until reviewed.', '',
              'Audio listening is required to grade pacing, pronunciation or whether a response interrupted the speaker. No audio was generated by this runner.']
    lines += ['', '| Case | Correctness | Naturalness | Clarification or N/A | Acknowledgment or N/A |',
              '|---|---|---|---|---|']
    for row in report['cases']:
        lines.append(f"| {row['id']} | | | | |")
    for row in report['cases']:
        if row.get('text'):
            lines += ['', f"### Case {row['id']}", '', cell(row['text']), '',
                      f"Answer-service time: {row['elapsed_ms']} ms. Reason: {cell(row.get('reason'))}.", '',
                      'Correctness: __ /5; naturalness: __ /5; clarification: __ /5 or N/A; acknowledgment: __ /5 or N/A.']
    lines += ['', '## Playback latency', '']
    timing = report.get('playback_latency')
    if not timing:
        lines += ['Not measured: no bot timing log was supplied. Answer-service time is not speech-end-to-first-audio latency.']
    else:
        lines += [f"Observed turns: {timing['observed_turns']}; completed: {timing['completed_turns']}.", '',
                  '| Completed-turn measurement | Samples | p50 ms | p95 ms |', '|---|---|---|---|']
        for key, value in timing['completed'].items():
            lines.append(f"| {key} | {value['n']} | {value['p50_ms']} | {value['p95_ms']} |")
    if report.get('comparison'):
        lines += ['', '## Before/after', '', report['comparison']['note'], '',
                  '| Case | Before | After |', '|---|---|---|']
        for pair in report['comparison']['pairs']:
            lines.append(f"| {pair['id']} | {cell(pair['before_text'] or pair['before_status'])} | {cell(pair['after_text'] or pair['after_status'])} |")
    if report.get('stage_timings'):
        lines += stage_markdown(report['stage_timings'])
    Path(output).write_text('\n'.join(lines)+'\n')


def stage_markdown(report):
    lines = ['', '## LangGraph and answer stages', '', report['note'], '',
             '| Stage | Samples | p50 ms | p95 ms | Errors | Cancelled |', '|---|---|---|---|---|---|']
    for name, row in report['stages'].items():
        lines.append(f"| {name} | {row['n']} | {row['p50_ms']} | {row['p95_ms']} | {row['errors']} | {row['cancelled']} |")
    for name, row in report['stages'].items():
        if row.get('outcomes'): lines += ['',name+' outcomes: '+', '.join(f'{k}={v}' for k,v in row['outcomes'].items())+'.']
    if not report['stages']: lines.append('No valid stage measurements were supplied.')
    if report['turns']:
        lines += ['', '### Per-turn stages', '',
                  'Blank means unmeasured. Graph/API columns include child work and must not be added to the LLM columns.', '',
                  '| Request UUID | Plan API ms | Lookup batch ms | Answer API ms | Generation ms | Verify ms | Graph total ms |',
                  '|---|---|---|---|---|---|---|']
        for identifier, spans in report['turns'].items():
            values = []
            for stage in ('rag_plan', 'rag_lookup_batch', 'rag_answer', 'generation', 'verify', 'rag_total'):
                samples = [s['elapsed_ms'] for s in spans if s['stage'] == stage]
                if stage == 'rag_lookup_batch' and not samples:
                    samples = [s['elapsed_ms'] for s in spans if s['stage'].startswith('rag_lookup:')]
                values.append(str(sum(samples)) if samples else '—')
            lines.append('| '+identifier+' | '+' | '.join(values)+' |')
    return lines


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Summarize private local voice logs without copying their text.')
    parser.add_argument('--stage-log', type=Path, required=True)
    parser.add_argument('--timing-log', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.suffix != '.json': parser.error('--output must end in .json')
    value = {'stage_timings': stage_report(args.stage_log)}
    if args.timing_log: value['playback_latency'] = latency_report(args.timing_log)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, indent=2)+'\n'); args.output.chmod(0o600)
    lines = ['# TINA voice stage timings'] + stage_markdown(value['stage_timings'])
    if args.timing_log:
        lines += ['', '## Bot playback (completed turns)', '', value['playback_latency']['note'], '',
                  '| Measurement | Samples | p50 ms | p95 ms |', '|---|---|---|---|']
        for name, row in value['playback_latency']['completed'].items():
            lines.append(f"| {name} | {row['n']} | {row['p50_ms']} | {row['p95_ms']} |")
        if not value['playback_latency']['completed']: lines.append('No completed-turn playback measurements supplied.')
    target = args.output.with_suffix('.md'); target.write_text('\n'.join(lines)+'\n'); target.chmod(0o600)
