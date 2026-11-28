"""Per-turn LangGraph orchestration; TINA owns permission, retrieval and final verification."""
import asyncio
from typing import TypedDict

from langgraph.graph import END, START, StateGraph
from langsmith import tracing_context
from voice_trace import voice_span
from voice_tools import TOOL_NAMES, normalize_tool_call

TOOLS = TOOL_NAMES
# Context reads, calculations, navigation and drafts retain their sequential dependency/side-effect rules.
PARALLEL_READS = frozenset(('get_recent_transcript', 'search_meeting', 'search_shared_meetings',
                          'search_shared_documents', 'search_approved_actions'))
SINGLE_SHOT_TOOLS = frozenset(('search_web', 'draft_task', 'draft_decision', 'open_source'))


class SourceAccessChanged(RuntimeError):
    """The core rejected source/session authority; never recover as an empty search."""


class RetrievalUnavailable(RuntimeError):
    """No successful evidence remains after a temporary read failure."""


class RagState(TypedDict):
    rounds: int
    calls: list[dict]
    executed: list[dict]
    result: dict
    has_evidence: bool
    unavailable: bool
    plan_complete: bool
    next: str


async def run_rag(request, agent, answer, is_current):
    def current():
        if not is_current(): raise RuntimeError('TINA turn changed')

    async def plan(state):
        current()
        with voice_span('rag_plan') as metrics:
            metrics['round'] = state['rounds'] + 1
            value = await agent(request, 'plan')
        current()
        calls = value.get('tool_calls') if isinstance(value, dict) else None
        if not isinstance(calls, list) or len(calls) > 2:
            raise ValueError('Invalid TINA tool plan')
        calls = [normalize_tool_call(call) for call in calls]
        seen = list(state['executed'])
        for call in calls:
            if call in seen:
                raise ValueError('Invalid or repeated TINA tool call')
            seen.append(call)
        return {'calls': calls, 'rounds': state['rounds'] + 1}

    async def lookup(state):
        async def execute(call):
            current()
            with voice_span('rag_lookup:' + call['name']) as metrics:
                metrics['round'] = state['rounds']
                try: result = await agent(request, 'lookup', call)
                except SourceAccessChanged:
                    metrics['lookup_outcome'] = 'access_changed'
                    raise
                current()
                if isinstance(result, dict): metrics['output_sources'] = result.get('source_count')
                outcome = None
                if call['name'] in PARALLEL_READS:
                    if not isinstance(result, dict): raise ValueError('Invalid TINA read result')
                    count = result.get('source_count')
                    if type(count) is not int or count < 0: raise ValueError('Invalid TINA source count')
                    if any(key in result and type(result[key]) is not bool
                           for key in ('retrieval_unavailable', 'budget_exhausted', 'skipped')):
                        raise ValueError('Invalid TINA lookup status')
                    outcome = ('unavailable' if result.get('retrieval_unavailable') or result.get('budget_exhausted')
                               or result.get('skipped') else 'found' if count else 'empty')
                    if result.get('lookup_status', outcome) != outcome: raise ValueError('Conflicting TINA lookup status')
                    metrics['lookup_outcome'] = outcome
            current()
            return outcome, bool(isinstance(result, dict) and result.get('plan_complete') is True)
        calls = state['calls']
        parallel = len(calls) > 1 and all(call['name'] in PARALLEL_READS for call in calls)
        with voice_span('rag_lookup_batch') as metrics:
            metrics.update(round=state['rounds'], tool_count=len(calls), parallel=parallel)
            if parallel:
                try:
                    async with asyncio.TaskGroup() as group:
                        tasks = [group.create_task(execute(call)) for call in calls]
                except ExceptionGroup as group:
                    matched, _ = group.split(SourceAccessChanged)
                    if matched is not None:
                        raise SourceAccessChanged('TINA parallel lookup failed: source access changed') from None
                    raise RuntimeError('TINA parallel lookup failed') from None
                results = [task.result() for task in tasks]
            else:
                results = [await execute(call) for call in calls]
        current()
        outcomes = [outcome for outcome, _ in results]
        single_shot = bool(calls) and all(call['name'] in SINGLE_SHOT_TOOLS for call in calls)
        all_complete = bool(results) and all(outcome == 'found' and done for outcome, done in results)
        return {'executed': state['executed'] + state['calls'],
                'has_evidence': state['has_evidence'] or 'found' in outcomes,
                'unavailable': state['unavailable'] or 'unavailable' in outcomes,
                'plan_complete': state['plan_complete'] or single_shot or all_complete}

    def assess(state):
        current()
        route = ('answer' if state['has_evidence'] else 'unavailable') if state['unavailable'] else (
            'answer' if state['plan_complete'] or state['rounds'] >= 2 else 'plan')
        with voice_span('rag_assess') as metrics:
            metrics['lookup_outcome'] = ('partial' if state['has_evidence'] else 'unavailable') if state['unavailable'] else (
                'found' if state['has_evidence'] else 'empty')
        return {'next': route}

    def unavailable(state):
        current()
        raise RetrievalUnavailable('TINA retrieval is temporarily unavailable')

    async def final(state):
        current()
        with voice_span('rag_answer'):
            result = await answer(request)
        current()
        if (not isinstance(result, dict) or not isinstance(result.get('text'), str)
                or not 1 <= len(result['text']) <= 4000):
            raise ValueError('Invalid TINA answer')
        return {'result': result}

    graph = StateGraph(RagState)
    graph.add_node('plan', plan)
    graph.add_node('lookup', lookup)
    graph.add_node('assess', assess)
    graph.add_node('unavailable', unavailable)
    graph.add_node('answer', final)
    graph.add_edge(START, 'plan' if agent else 'answer')
    graph.add_conditional_edges('plan', lambda state: 'lookup' if state['calls'] else 'answer')
    graph.add_edge('lookup', 'assess')
    graph.add_conditional_edges('assess', lambda state: state['next'])
    graph.add_edge('unavailable', END)
    graph.add_edge('answer', END)
    # No checkpoints or external traces: credentials and verified text stay within this turn.
    with tracing_context(enabled=False), voice_span('rag_total', request.get('body', {}).get('request_id')):
        state = await graph.compile().ainvoke({'rounds': 0, 'calls': [], 'executed': [], 'result': {},
            'has_evidence': False, 'unavailable': False, 'plan_complete': False, 'next': ''},
            config={'recursion_limit': 10, 'callbacks': []})
    return state['result']
