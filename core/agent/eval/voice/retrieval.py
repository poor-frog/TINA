"""Offline retrieval evaluation over a pinned private transcript snapshot; no answer-LLM/API calls."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from statistics import mean
from statistics import median
import time

from shared.meeting_knowledge import sources_for
from shared.voice_knowledge import voice_chunks, voice_sources


def load_cases(snapshot, dataset):
    raw = snapshot.read_bytes()
    body, gold = json.loads(raw), json.loads(dataset.read_text())
    if gold.get('snapshot_sha256') != hashlib.sha256(raw).hexdigest():
        raise ValueError('Transcript snapshot changed; recheck the reference labels')
    meetings = body.get('meetings', [])
    if (not isinstance(meetings, list) or not meetings or len(meetings) > 20
            or any(not isinstance(m, dict) or type(m.get('meeting_id')) is not int or m['meeting_id'] <= 0
                   or type(m.get('owner_id')) is not int for m in meetings)
            or len({m['meeting_id'] for m in meetings}) != len(meetings)
            or len({m['owner_id'] for m in meetings}) != 1):
        raise ValueError('A benchmark must stay within one owner scope')
    by_id = {m['meeting_id']: m['canonical'] for m in meetings}
    cases, seen = gold.get('cases'), set()
    if not isinstance(cases, list) or not 1 <= len(cases) <= 200:
        raise ValueError('Expected 1–200 labelled cases')
    for case in cases:
        identifier = case.get('id')
        if not isinstance(identifier, str) or not 1 <= len(identifier) <= 80 or identifier in seen:
            raise ValueError('Missing or duplicate case ID')
        seen.add(identifier)
        if (case.get('expected') not in ('answerable', 'unanswerable', 'clarification')
                or case.get('review_status') not in ('draft', 'approved')
                or not isinstance(case.get('question'), str) or not 1 <= len(case['question'].strip()) <= 2000
                or not isinstance(case.get('reference_answer'), str)
                or not isinstance(case.get('meeting_ids'), list) or not 1 <= len(case['meeting_ids']) <= 4
                or any(type(mid) is not int or mid not in by_id for mid in case['meeting_ids'])):
            raise ValueError('Invalid reference case')
        refs = case.get('evidence')
        if not isinstance(refs, list) or (case['expected'] == 'answerable') != bool(refs):
            raise ValueError('Only answerable cases require reference evidence')
        for ref in refs:
            if ref.get('meeting_id') not in case['meeting_ids']: raise ValueError('Evidence outside case scope')
            segments = by_id[ref['meeting_id']]['segments']
            source = next((s for s in segments if s['segment_id'] == ref.get('segment_id')), None)
            if (source is None or ref.get('revision') != source.get('revision')
                    or not isinstance(ref.get('quote'), str) or not ref['quote']
                    or ref['quote'] not in source['text']):
                raise ValueError('Reference quote/revision no longer matches its source')
            if type(ref.get('relevance', 1)) is not int or not 1 <= ref.get('relevance', 1) <= 3:
                raise ValueError('Relevance grade must be 1–3')
    return by_id, gold


def evaluate(by_id, gold, *, semantic=None, version='v2', rerank=None, k=10, result_limit=12):
    if (version not in ('v1', 'v2') or type(k) is not int or type(result_limit) is not int
            or not 1 <= k <= result_limit <= 48): raise ValueError('Invalid retrieval evaluation mode')
    rows = []
    for case in gold['cases']:
        candidates = []
        for mid in case['meeting_ids']:
            candidates.extend(s | {'meeting_id': mid, 'current_meeting': mid == case['meeting_ids'][0]}
                              for s in sources_for(by_id[mid], {}))
        started = time.monotonic()
        selected, _ = voice_sources(voice_chunks(candidates), case['question'], [], 0,
                                    semantic=semantic, retrieval_version=version)
        def evidence_ranks(sources):
            return [next((i+1 for i, s in enumerate(sources) if s.get('meeting_id') == ref['meeting_id']
                          and s.get('segment_id') == ref['segment_id'] and ref['quote'] in s['quote']), None)
                    for ref in case['evidence']]
        before_hits, before_count = evidence_ranks(selected), len(selected)
        if rerank is not None and selected: selected = rerank(case['question'], selected)
        # BGE, LLM (including fallback), and the baseline share one final evidence budget.
        selected = selected[:result_limit]
        hits = evidence_ranks(selected)
        relevant = {}
        for ref in case['evidence']:
            key = (ref['meeting_id'], ref['segment_id'])
            relevant[key] = max(relevant.get(key, 0), ref.get('relevance', 1))
        seen, gains = set(), []
        for source in selected[:k]:
            key = (source.get('meeting_id'), source.get('segment_id'))
            gain = max((ref.get('relevance', 1) for ref in case['evidence']
                        if (ref['meeting_id'], ref['segment_id']) == key and ref['quote'] in source['quote']), default=0)
            gains.append(gain if key not in seen else 0)
            if gain: seen.add(key)
        ideal = sorted(relevant.values(), reverse=True)[:k]
        def dcg(grades): return sum((2**grade-1)/math.log2(i+2) for i, grade in enumerate(grades))
        row = {'id': case['id'], 'expected': case['expected'], 'review_status': case['review_status'],
               'candidate_count': len(candidates), 'retrieved_count': len(selected),
               'pre_rerank_count': before_count,
               'pre_rerank_evidence_recall': sum(h is not None for h in before_hits)/len(before_hits) if before_hits else None,
               'retrieval_ms': round((time.monotonic()-started)*1000, 2),
               'selected_keys': [s['key'] for s in selected],
               'recall_at_k': sum(h is not None and h <= k for h in hits)/len(hits) if hits else None,
               'ndcg_at_k': dcg(gains)/dcg(ideal) if ideal else None,
               'gold_evidence_recall': sum(h is not None for h in hits)/len(hits) if hits else None,
               'reciprocal_rank': 1/min(h for h in hits if h is not None) if any(hits) else 0 if hits else None,
               'all_evidence_found': all(h is not None for h in hits) if hits else None}
        rows.append(row)
    positives = [r for r in rows if r['expected'] == 'answerable']
    latencies = sorted(r['retrieval_ms'] for r in rows)
    return {'snapshot_sha256': gold['snapshot_sha256'], 'cases': rows, 'retrieval_version': version, 'k': k,
            'result_limit': result_limit,
            'summary': {'cases': len(rows), 'answerable': len(positives),
                        'approved_cases': sum(r['review_status'] == 'approved' for r in rows),
                        'mean_gold_evidence_recall': mean(r['gold_evidence_recall'] for r in positives) if positives else None,
                        'mean_pre_rerank_evidence_recall': mean(r['pre_rerank_evidence_recall'] for r in positives) if positives else None,
                        'mean_reciprocal_rank': mean(r['reciprocal_rank'] for r in positives) if positives else None,
                        'all_evidence_found_cases': sum(r['all_evidence_found'] for r in positives),
                        'mean_recall_at_k': mean(r['recall_at_k'] for r in positives) if positives else None,
                        'mean_ndcg_at_k': mean(r['ndcg_at_k'] for r in positives) if positives else None,
                        'retrieval_p50_ms': median(latencies), 'retrieval_p95_ms': latencies[math.ceil(.95*len(latencies))-1],
                        'mean_retrieval_ms': mean(r['retrieval_ms'] for r in rows)},
            'note': 'Provisional while labels remain draft. Evaluates finding exact labelled evidence within the selected transcript scope; not answer correctness, ASR accuracy, negative-answer rejection, or perceived voice latency. NDCG uses supplied 1–3 relevance or binary grade 1 and treats unjudged segments as zero; it is not complete relevance ground truth. Small source pools can make retrieval appear easy.'}


def answer_report(gold, answers):
    """Score supplied per-case results separately; never infer correctness from keywords or HTTP 200."""
    by_id = {c['id']: c for c in gold['cases']}
    rows, seen = [], set()
    if (not isinstance(answers, dict) or not isinstance(answers.get('cases', []), list)
            or len(answers.get('cases', [])) > 200): raise ValueError('Invalid recorded answer cases')
    for answer in answers.get('cases', []):
        if not isinstance(answer, dict): raise ValueError('Invalid recorded answer')
        identifier = answer.get('id')
        if identifier not in by_id or identifier in seen: raise ValueError('Unknown or duplicate answer case')
        seen.add(identifier); case = by_id[identifier]
        reason = answer.get('reason')
        if not isinstance(reason, str): raise ValueError('Answer reason is required')
        failed = reason in {'llm_unavailable', 'verification_unavailable', 'web_unavailable', 'service_error', 'generation_format_invalid', 'web_answer_empty'}
        refused = reason in {'insufficient_evidence', 'no_shared_sources', 'verification_rejected', 'web_numeric_mismatch'}
        correct = answer.get('human_correct')
        if correct is not None and type(correct) is not bool: raise ValueError('Human correctness must be boolean or null')
        rows.append({'id': identifier, 'service_error': failed,
                     'answerable_refused': case['expected'] == 'answerable' and refused,
                     'negative_answer_needs_review': case['expected'] != 'answerable' and reason == 'answered',
                     'human_correct': correct if case['review_status'] == 'approved' else None})
    reviewed = [r['human_correct'] for r in rows if r['human_correct'] is not None]
    return {'evaluated_cases': len(rows), 'not_run': len(by_id)-len(rows), 'cases': rows,
            'service_errors': sum(r['service_error'] for r in rows),
            'answerable_refusals': sum(r['answerable_refused'] for r in rows),
            'negative_answers_needing_review': sum(r['negative_answer_needs_review'] for r in rows),
            'human_reviewed_cases': len(reviewed), 'human_correct_rate': mean(reviewed) if reviewed else None,
            'note': 'Refusal/negative flags are provisional against draft references. Service failures are separate. Correctness is scored only from explicit human ratings on approved labels; model text is not copied into this report.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--semantic', action='store_true', help='Use pinned local E5; never downloads weights')
    parser.add_argument('--answers', type=Path, help='Optional local recorded per-case answer reasons and human ratings')
    parser.add_argument('--retrieval-version', choices=['v1', 'v2'], default='v2')
    parser.add_argument('--k', type=int, default=10)
    parser.add_argument('--result-limit', type=int, default=12, help='Common final evidence depth for baseline, BGE and LLM; must be >= k')
    parser.add_argument('--bge-directory', type=Path, help='Optional verified local BGE weights; offline candidate evaluation only')
    parser.add_argument('--bge-device', choices=['cpu', 'mps', 'cuda'], default='cpu')
    parser.add_argument('--llm-rerank', action='store_true', help='Explicitly call the configured deployment completion provider; may incur charges')
    args = parser.parse_args()
    if args.output.suffix != '.json': parser.error('--output must end in .json')
    if args.bge_directory and args.llm_rerank: parser.error('Choose either BGE or LLM reranking')
    by_id, gold = load_cases(args.snapshot, args.dataset)
    health = {'requested': args.semantic, 'calls': 0, 'unavailable_calls': 0}
    def semantic(question, sources):
        from control_plane import voice_retrieval
        health['calls'] += 1
        result = voice_retrieval.semantic_rank('local-eval:' + gold['snapshot_sha256'], question, sources)
        if voice_retrieval._failed or voice_retrieval._encoder is None: health['unavailable_calls'] += 1
        return result
    reranker = None
    if args.bge_directory:
        from control_plane.voice_reranker import Reranker
        reranker = Reranker(args.bge_directory, args.bge_device)
    llm_outcomes = []
    if args.llm_rerank:
        from llm import completion_from_env, LLMStructuredOutputUnsupported
        from shared.voice_rerank import rerank_voice_sources, RERANK_SYSTEM
        from shared.voice_schema import voice_schema
        def llm_rerank(question, sources):
            provider = completion_from_env(timeout=4)
            def complete(prompt):
                structured = getattr(provider, 'complete_structured', None)
                if structured is not None:
                    try: return structured(prompt, system=RERANK_SYSTEM, schema=voice_schema('rerank', sources)).text
                    except LLMStructuredOutputUnsupported: pass
                return provider.complete(prompt, system=RERANK_SYSTEM).text
            rows, outcome = rerank_voice_sources(question, sources, [], [], complete)
            llm_outcomes.append(outcome)
            return rows
        reranker = llm_rerank
    report = evaluate(by_id, gold, semantic=semantic if args.semantic else None,
                      version=args.retrieval_version, rerank=reranker, k=args.k, result_limit=args.result_limit)
    if args.bge_directory:
        from control_plane.voice_reranker import MANIFEST
        report['reranker'] = {'model': MANIFEST['model'], 'revision': MANIFEST['revision'],
            'weights_sha256': MANIFEST['files']['model.safetensors']['sha256'],
            'device': args.bge_device, 'load_ms': reranker.load_ms}
    if args.llm_rerank:
        import os
        report['reranker'] = {'kind': 'llm', 'provider': os.environ.get('TINA_LLM_PROVIDER', 'openai-compat'),
            'model': os.environ.get('TINA_LLM_MODEL'),
            'outcomes': {outcome: llm_outcomes.count(outcome) for outcome in ('applied', 'empty', 'skipped', 'fallback')}}
    report['semantic'] = health
    report['mode'] = 'bm25' if not args.semantic else 'hybrid-fallback' if health['unavailable_calls'] else 'hybrid'
    report['dataset_sha256'] = hashlib.sha256(args.dataset.read_bytes()).hexdigest()
    shared_dir = Path(__file__).parents[2] / 'shared'
    report['implementation_sha256'] = {name: hashlib.sha256((shared_dir/name).read_bytes()).hexdigest()
        for name in ('voice_knowledge.py', 'voice_lexical.py', 'voice_evidence.py')}
    from importlib.metadata import version, PackageNotFoundError
    report['package_versions'] = {}
    for package in ('underthesea', 'underthesea-core', 'onnxruntime', 'tokenizers', 'torch', 'transformers'):
        try: report['package_versions'][package] = version(package)
        except PackageNotFoundError: pass
    report['answers'] = answer_report(gold, json.loads(args.answers.read_text()) if args.answers else {})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n'); args.output.chmod(0o600)
    lines = ['# Private TINA transcript retrieval baseline', '', report['note'], '',
             f"Mode: {report['mode']}. Cases: {report['summary']['cases']}. Approved labels: {report['summary']['approved_cases']}.",
             f"Final evidence limit: {report['result_limit']}; ranking k: {report['k']}. Pre-rerank coverage is reported separately in JSON.", '',
             '| Case | Expected | Evidence recall | First-hit reciprocal rank | Retrieval ms |', '|---|---|---|---|---|']
    for row in report['cases']:
        lines.append(f"| {row['id']} | {row['expected']} | {row['gold_evidence_recall']} | {row['reciprocal_rank']} | {row['retrieval_ms']} |")
    answers = report['answers']
    lines += ['', '## Answer evaluation', '', answers['note'], '',
              f"Evaluated: {answers['evaluated_cases']}; not run: {answers['not_run']}; service errors: {answers['service_errors']}.",
              f"Answerable refusals: {answers['answerable_refusals']}; negative answers needing review: {answers['negative_answers_needing_review']}.",
              f"Human-reviewed: {answers['human_reviewed_cases']}; correctness: {answers['human_correct_rate']}."]
    target = args.output.with_suffix('.md'); target.write_text('\n'.join(lines)+'\n'); target.chmod(0o600)
    print(json.dumps({'mode': report['mode'], 'summary': report['summary'], 'semantic': health}))


if __name__ == '__main__': main()
