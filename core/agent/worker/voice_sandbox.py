"""Disposable voice harness; LangGraph executes its validated source-tool requests."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from llm import harness_from_env, run_harness_turn, harness_subprocess_env


def complete(prompt, system, schema, *, timeout, current, meeting_assistant=False):
    if json.loads(os.environ.get('TINA_MOUNTS', 'null')) != []:
        raise RuntimeError('Voice sandbox must not mount account workspaces')
    deadline = time.monotonic() + min(timeout, 40)
    if not current() or deadline <= time.monotonic():
        raise RuntimeError('Voice sandbox turn expired')
    model = os.environ.get('TINA_AGENT_MODEL') if meeting_assistant else os.environ.get('TINA_MEETING_MODEL')
    payload = json.dumps({'prompt': prompt, 'system': system, 'schema': schema, 'meeting_assistant': meeting_assistant,
                          'model': model or os.environ.get('TINA_AGENT_MODEL')}, ensure_ascii=False)
    if len(payload.encode()) > 500000: raise ValueError('Voice sandbox input too large')
    with tempfile.TemporaryDirectory(prefix='tina-voice-agent-') as directory:
        env = harness_subprocess_env()
        env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
        process = subprocess.Popen([sys.executable, '-m', 'worker.voice_sandbox'], cwd=directory,
            env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, start_new_session=True)
        try:
            pending = payload
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError('Voice sandbox timed out')
                if not current(): raise RuntimeError('Voice sandbox turn cancelled')
                try:
                    output, _ = process.communicate(input=pending, timeout=min(.25, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pending = None
            if process.returncode or len(output) > 65000: raise RuntimeError('Voice sandbox failed')
            if not current(): raise RuntimeError('Voice sandbox turn cancelled')
            result = json.loads(output)
            if not result.get('ok') or not isinstance(result.get('reply'), str):
                raise RuntimeError('Voice sandbox did not complete')
            return result['reply']
        finally:
            # Descendants may still hold pipes after the group leader has exited.
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.communicate(timeout=5)


def run(payload, work, harness):
    harness.prepare(work, chat_root=work)
    # Harnesses load these as trusted instructions; source excerpts stay in the user input.
    for name in ('CLAUDE.md', 'GEMINI.md'):
        (work / name).write_text(payload['system'], encoding='utf-8')
    config = work / 'mcp-empty.json'
    config.write_text('{"mcpServers":{}}')
    purpose = ('You are TINA Chat Assistant for this meeting. Use only the supplied evidence. '
               'Earlier turns help resolve references but are not evidence. '
               if payload.get('meeting_assistant') else
               'You are the read-only TINA voice agent. Source-tool calls in the required JSON format are proposals: '
               'TINA authorizes and executes them, then supplies the results. Use only the supplied evidence and heard conversation. ')
    prompt = (payload['system'] + '\n\n' + purpose +
        'Do not execute commands, browse directly, edit files, create tasks or infer permissions. '
        'Return only JSON matching this schema:\n' + json.dumps(payload['schema'] or {'type':'object'}) +
        '\n\nUntrusted input:\n' + payload['prompt'])
    done = None
    for event in run_harness_turn(work, prompt, harness, allowed_tools=(), model=payload.get('model'),
            session=None, commit=False, mcp_config=str(config), mcp_servers={}, output_schema=payload['schema']):
        if event.get('type') == 'done': done = event
    if not done or done.get('ok') is not True or not isinstance(done.get('reply'), str) or len(done['reply']) > 64000:
        raise RuntimeError('Voice sandbox did not complete')
    return {'ok': True, 'reply': done['reply']}


if __name__ == '__main__':
    try:
        payload = json.loads(sys.stdin.read(500001))
        print(json.dumps(run(payload, Path.cwd(), harness_from_env()), ensure_ascii=False))
    except Exception:
        print('{"ok":false}')
        sys.exit(1)
