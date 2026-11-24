"""workspace_reader.py — read a subject's workspace (the git knowledge graph) for the Workspace surface.

Read-only view over the per-subject workspace dir the chat runner maintains. Hides `.git`/`.claude`
internals and guards against path traversal (a read path can never escape the subject's workspace).
"""
from __future__ import annotations

import json
import glob
import os
import re
from pathlib import Path
from typing import Optional
from llm import render_citations, web_sources


def _tool_op(name: str) -> dict:
    """Classify a claude tool name into one of the terminal's op labels (read/search/edit/git/web/tool).
    Mirrors the frontend ``toolOp`` so the loaded history reads the same as a live turn."""
    t = (name or "").lower()
    if any(k in t for k in ("read", "cat", "open")) and "edit" not in t:
        label = "read"
    elif any(k in t for k in ("search", "grep", "find", "glob")):
        label = "search"
    elif any(k in t for k in ("edit", "write", "append")):
        label = "edit"
    elif any(k in t for k in ("git", "commit")):
        label = "git"
    elif any(k in t for k in ("web", "fetch", "http")):
        label = "web"
    else:
        label = "tool"
    return {"label": label}


def _block_text(content) -> str:
    """Concatenate the ``text`` of an assistant message's content (string, or list of blocks)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _codex_block_text(content: object) -> str:
    """Concatenate Codex Responses text blocks from a rollout item."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict)
            and block.get("type") in ("input_text", "output_text", "text")
            and isinstance(block.get("text"), str)
        )
    return ""


# `.git` is pure plumbing — huge/noisy, never useful in the Files tree — so it's hidden
# unconditionally. Everything else dot-prefixed (`.claude` + any dotfile/dotdir) is hidden by
# default but surfaced when the caller opts in via ``hidden=True``.
_ALWAYS_HIDDEN = {".git"}

# Commit authors that are platform/seed PLUMBING, not a member's agent — classified ``system`` so the
# activity feed never mistakes a policy or seed commit for a member push. The per-mount turn-commit stamps
# a member's principal instead (name=<subject>, email=<subject>@tina.local — see worker/engine.py, D4).
_SYSTEM_AUTHOR_EMAILS = {"platform@tina.local", "agent@tina"}
_SYSTEM_AUTHOR_NAMES = {"tina-platform", "tina-agent"}


class WorkspaceReader:
    def __init__(self, workspaces_dir: str) -> None:
        self._root = Path(workspaces_dir)

    @property
    def root(self) -> Path:
        return self._root

    def _ws(self, subject: str) -> Path:
        ws = (self._root / subject).resolve()
        root = self._root.resolve()
        if ws != root and root not in ws.parents:  # traversal guard (subject must stay under root)
            raise ValueError("invalid subject")
        return ws

    def workspace_dir(self, subject: str) -> Path:
        return self._ws(subject)

    def _guard_under_root(self, base: Path) -> Path:
        """A workspace dir must live under the store root (traversal guard). Used by the path-based
        readers so a mount PATH (from the active set — own private slots under .attached, or a shared
        workspace at <root>/<id>) can be read directly, not only a ``<root>/<subject>`` dir."""
        base = base.resolve()
        root = self._root.resolve()
        if base != root and root not in base.parents:
            raise ValueError("outside root")
        return base

    def tree(self, subject: str, hidden: bool = False) -> list[str]:
        """Sorted relative paths of the subject's files (the subject's own ``<root>/<subject>`` dir)."""
        return self.tree_at(self._ws(subject), hidden=hidden)

    def tree_at(self, base: Path, hidden: bool = False) -> list[str]:
        """Sorted relative paths of the files under ``base`` (any workspace dir under the store root).

        Always excludes ``.git`` internals. By default also excludes ``.claude`` and any other
        dotfile/dotdir; pass ``hidden=True`` to include those. ``.git`` stays hidden either way.
        """
        ws = self._guard_under_root(base)
        if not ws.exists():
            return []
        out: list[str] = []
        for p in sorted(ws.rglob("*")):
            parts = p.relative_to(ws).parts
            if any(part in _ALWAYS_HIDDEN for part in parts):
                continue
            if not hidden and any(part.startswith(".") for part in parts):
                continue
            if p.is_file():
                out.append(str(p.relative_to(ws)))
        return out

    def read(self, subject: str, path: str) -> Optional[str]:
        """The text at ``path`` within the subject's own workspace, or None if absent. Traversal-guarded."""
        return self.read_at(self._ws(subject), path)

    def search_at(self, base: Path, query: str) -> dict:
        """Literal Unicode content search; hidden files and symlinks never enter the corpus."""
        ws = self._guard_under_root(base)
        hits, scanned, size, bounded = [], 0, 0, False
        for directory, folders, files in os.walk(ws):
            folders[:] = sorted(d for d in folders if not d.startswith('.') and not (Path(directory) / d).is_symlink())
            for name in sorted(files):
                path = Path(directory) / name
                if name.startswith('.') or path.suffix != '.md' or path.is_symlink():
                    continue
                safe = self._workspace_child(ws, path.relative_to(ws))
                if safe is None:
                    continue
                if scanned >= 1000 or size >= 10_000_000:
                    return {'hits': hits, 'scanned': scanned, 'bounded': True}
                with safe.open('rb') as source:
                    raw = source.read(500001)
                scanned += 1
                size += len(raw)
                if len(raw) > 500000:
                    bounded = True
                    continue
                try:
                    text = raw.decode('utf-8')
                except UnicodeDecodeError:
                    continue
                for number, line in enumerate(text.splitlines(), 1):
                    position = line.casefold().find(query.casefold())
                    if position >= 0:
                        hits.append({'path': path.relative_to(ws).as_posix(), 'line': number,
                                     'text': line[max(0, position - 80):position + 220]})
                        if len(hits) >= 50:
                            return {'hits': hits, 'scanned': scanned, 'bounded': True}
        return {'hits': hits, 'scanned': scanned, 'bounded': bounded}

    def read_at(self, base: Path, path: str) -> Optional[str]:
        """The text at ``path`` within the ``base`` workspace dir, or None if absent. Traversal-guarded."""
        ws = self._guard_under_root(base)
        f = self._workspace_child(ws, path)
        if f is None:
            raise ValueError("invalid path")
        return f.read_text() if f.exists() and f.is_file() else None

    @staticmethod
    def _workspace_child(ws: Path, relative: str | Path) -> Optional[Path]:
        """Resolve a workspace-relative path without following symlinks outside that workspace."""
        try:
            child = (ws / relative).resolve()
        except (OSError, RuntimeError):
            return None
        return child if ws in child.parents else None

    def _session_id(self, ws: Path, session: str) -> Optional[str]:
        """The claude sessionId for a thread, read from its continuity pointer
        (``.claude/sessions/<session>.session``; the legacy ``main`` falls back to ``.claude/.session``)."""
        candidates = [Path(".claude") / "sessions" / f"{session}.session"]
        if session == "main":
            candidates.append(Path(".claude") / ".session")
        for relative in candidates:
            f = self._workspace_child(ws, relative)
            if f is None:
                continue
            try:
                if f.exists() and f.is_file():
                    sid = f.read_text().strip()
                    if sid:
                        return sid
            except OSError:
                continue
        return None

    def _codex_history(self, roots: list[Path], session_id: str) -> Optional[list[dict]]:
        """Read a Codex thread's private rollout JSONL into the same UI turn shape as Claude history."""
        if not session_id or Path(session_id).name != session_id or "\\" in session_id:
            return None
        safe_id = glob.escape(session_id)
        for ws in roots:
            files: set[Path] = set()
            for directory_name in ("sessions", "archived_sessions"):
                directory = self._workspace_child(ws, Path(".codex") / directory_name)
                if directory is None or not directory.is_dir():
                    continue
                for candidate in directory.rglob(f"rollout-*-{safe_id}.jsonl"):
                    files.add(candidate)
                for candidate in directory.rglob(f"rollout-*-{safe_id}_*.jsonl"):
                    files.add(candidate)
            safe_files: list[Path] = []
            for candidate in sorted(files, key=lambda path: path.name):
                try:
                    relative = candidate.relative_to(ws)
                except ValueError:
                    continue
                safe_candidate = self._workspace_child(ws, relative)
                if safe_candidate is not None and safe_candidate.is_file():
                    safe_files.append(safe_candidate)
            if not safe_files:
                continue

            turns: list[dict] = []
            cur_agent: Optional[dict] = None
            sources: list[dict] = []
            source_turns: set[str] = set()
            current_turn_id: str | None = None

            def flush_agent() -> None:
                nonlocal cur_agent, sources, source_turns
                if cur_agent is not None:
                    cur_agent['text'] = render_citations(cur_agent['text'], sources)
                    turns.append(cur_agent)
                    cur_agent = None
                sources = []
                source_turns = set()

            for path in safe_files:
                try:
                    raw = path.read_text(encoding="utf-8")
                except OSError:
                    continue
                records = []
                for line in raw.splitlines():
                    try:
                        record = json.loads(line)
                    except (json.JSONDecodeError, ValueError):
                        continue
                    if isinstance(record, dict) and isinstance(record.get('payload'), dict):
                        records.append(record)
                user_events = any(r.get('type') == 'event_msg' and r['payload'].get('type') == 'user_message' for r in records)
                for record in records:
                    if record.get('type') == 'event_msg' and record['payload'].get('type') == 'task_started':
                        value = record['payload'].get('turn_id')
                        current_turn_id = value if isinstance(value, str) else None
                    if record.get('type') == 'event_msg' and record['payload'].get('type') == 'user_message':
                        text = record['payload'].get('message')
                        if isinstance(text, str) and text.strip():
                            flush_agent()
                            turns.append({'role': 'user', 'text': text})
                        continue
                    if record.get("type") != "response_item":
                        continue
                    item = record.get("payload")
                    if not isinstance(item, dict):
                        continue
                    item_type = item.get("type")
                    sources = [*sources, *web_sources(item)][:50]
                    if item_type == "message":
                        text = _codex_block_text(item.get("content"))
                        if not text.strip():
                            continue
                        if item.get("role") == "user":
                            if user_events or re.fullmatch(r'\s*<(environment_context|user_instructions)>[\s\S]*</\1>\s*', text):
                                continue
                            flush_agent()
                            turns.append({"role": "user", "text": text})
                        elif item.get("role") == "assistant":
                            turn_id = current_turn_id or (item.get('internal_chat_message_metadata_passthrough') or {}).get('turn_id')
                            if isinstance(turn_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', turn_id) and turn_id not in source_turns:
                                source_turns.add(turn_id)
                                cached = self._workspace_child(ws, Path('.codex/tina-sources') / session_id / f'{turn_id}.json')
                                if cached is not None and cached.is_file():
                                    try:
                                        with cached.open('rb') as stream:
                                            raw_sources = stream.read(500001)
                                        stored = json.loads(raw_sources) if len(raw_sources) <= 500000 else None
                                        if isinstance(stored, list):
                                            sources = [*stored[:50], *sources][:50]
                                    except (OSError, ValueError):
                                        pass
                            if cur_agent is None:
                                cur_agent = {"role": "agent", "text": "", "ops": []}
                            cur_agent["text"] += ('\n\n' if cur_agent['text'] else '') + text
                    elif item_type in ("function_call", "mcp_tool_call", "web_search_call"):
                        name = item.get("name")
                        if item_type == 'web_search_call':
                            name = 'WebSearch'
                        if item_type == "mcp_tool_call":
                            server, tool = item.get("server"), item.get("tool")
                            if isinstance(server, str) and isinstance(tool, str):
                                name = f"mcp__{server}__{tool}"
                        if isinstance(name, str) and name:
                            if cur_agent is None:
                                cur_agent = {"role": "agent", "text": "", "ops": []}
                            tool = {'exec_command': 'Bash', 'write_stdin': 'Bash', 'apply_patch': 'Edit'}.get(name, name)
                            cur_agent["ops"].append(_tool_op(tool) | {'tool': tool})
            flush_agent()
            return turns
        return None

    def _continuity_roots(self, subject: str, extra_roots: "list[str | Path] | None" = None) -> list[Path]:
        """Private workspace dirs where this subject's continuity may live.

        New chats live in ``.system/<subject>``; older threads may still be in the subject's own
        workspace or one of their parked private slots. Shared workspace roots are deliberately
        excluded: membership shares documents, never another member's private chat history.
        """
        root = self._root.resolve()
        home = self._ws(subject)
        from control_plane.system_mounts import system_store_path
        system = system_store_path(root, subject).resolve()
        legacy_system = (root / ".system" / subject).resolve()
        attached = root / ".attached" / subject
        attached_root: Optional[Path] = None
        candidates: list[Path] = [system, home]
        if system != legacy_system and not (root / ".system" / subject).is_symlink():
            candidates.append(legacy_system)
        if attached.is_dir() and not attached.is_symlink():
            try:
                resolved_attached = attached.resolve()
                if resolved_attached.parent == (root / ".attached").resolve():
                    attached_root = resolved_attached
                    candidates.extend(
                        slot.resolve()
                        for slot in sorted(attached_root.iterdir())
                        if slot.is_dir() and not slot.is_symlink()
                        and slot.resolve().parent == attached_root
                    )
            except (OSError, RuntimeError):
                attached_root = None
        for e in extra_roots or []:
            try:
                candidate = self._guard_under_root(Path(e))
            except ValueError:
                continue
            # Extra roots are a compatibility seam for private mounts only. Never let a caller turn
            # shared-workspace membership into access to another member's continuity files.
            if candidate in (home, system) or (attached_root is not None and candidate.parent == attached_root):
                candidates.append(candidate)
        out: list[Path] = []
        seen: set[str] = set()
        for c in candidates:
            try:
                c = self._guard_under_root(c)
            except ValueError:
                continue
            k = str(c)
            if k in seen or not c.exists():
                continue
            seen.add(k)
            out.append(c)
        return out

    def history(self, subject: str, session: str, extra_roots: "list[str | Path] | None" = None,
                provider_sessions: list[str] | None = None) -> list[dict]:
        """The session's prior conversation as ordered, terminal-renderable turns.

        Resolves the thread's claude sessionId from its continuity pointer, finds the transcript JSONL
        under ``<ws>/.claude/projects/<cwd-slug>/<sessionId>.jsonl``, and parses it into ``Turn``-shaped
        dicts: user turns ``{role:"user", text}``; agent turns ``{role:"agent", text, ops, commit?}``.
        Pointer and transcript are searched across every continuity root (``_continuity_roots``) — they
        normally co-locate, but a thread that MOVED anchors (cwd-rooted → _system-rooted) may have them
        apart. Tolerant by design — a missing pointer/file or unparseable lines yield ``[]`` (never
        raises), so the surface degrades to "no history yet" rather than erroring."""
        if "/" in session or "\\" in session or session in ("", ".", ".."):
            return []
        roots = self._continuity_roots(subject, extra_roots)
        sid: Optional[str] = None
        for ws in roots:
            sid = self._session_id(ws, session)
            if sid:
                break
        if not sid:
            return []
        indexed = []
        for ws in roots:
            index = self._workspace_child(ws, Path('.claude/sessions') / f'{session}.history.json')
            if index is None or not index.is_file():
                continue
            try:
                value = json.loads(index.read_text())
                if isinstance(value, list) and all(isinstance(item, str) for item in value):
                    indexed = value
                    break
            except (ValueError, OSError):
                continue
        # Merge chronological Stream recovery with the durable index, retaining older entries
        # even when Redis has already trimmed their events.
        ordered = list(dict.fromkeys(item for item in provider_sessions or [] if isinstance(item, str)))
        for position, item in enumerate(indexed):
            if item in ordered:
                continue
            following = next((known for known in indexed[position + 1:] if known in ordered), None)
            ordered.insert(ordered.index(following) if following else len(ordered), item)
        if sid not in ordered:
            ordered.append(sid)
        return [turn for item in ordered for turn in self._history_for_id(roots, item)]

    def _history_for_id(self, roots: list[Path], sid: str) -> list[dict]:
        if not sid or sid in ('.', '..') or Path(sid).name != sid or '\\' in sid:
            return []
        # The cwd-slug dir is claude's encoding of the workspace path; there is normally one, but match by
        # the sessionId filename to be safe. Shared roots are excluded above; resolved transcript paths
        # must also remain under each private workspace in case .claude/projects contains a symlink.
        path: Optional[Path] = None
        for ws in roots:
            projects = self._workspace_child(ws, Path(".claude") / "projects")
            if projects is None or not projects.exists():
                continue
            for cand in projects.glob(f"*/{glob.escape(sid)}.jsonl"):
                try:
                    relative = cand.relative_to(ws)
                except ValueError:
                    continue
                safe_cand = self._workspace_child(ws, relative)
                if safe_cand is not None and safe_cand.is_file():
                    path = safe_cand
                    break
            if path is not None:
                break
        if path is None:
            codex_turns = self._codex_history(roots, sid)
            return codex_turns if codex_turns is not None else []
        try:
            raw = path.read_text()
        except OSError:
            return []

        turns: list[dict] = []
        cur_agent: Optional[dict] = None  # the open agent turn we accumulate text/ops onto

        def flush_agent() -> None:
            nonlocal cur_agent
            if cur_agent is not None:
                turns.append(cur_agent)
                cur_agent = None

        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                continue
            if not isinstance(obj, dict):
                continue
            kind = obj.get("type")
            msg = obj.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None

            if kind == "user":
                # A real user prompt is a plain string or a content list with text blocks. A list that is
                # ONLY tool_results belongs to the preceding agent turn (a tool round-trip) — skip it.
                is_tool_result = (
                    isinstance(content, list)
                    and content
                    and all(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)
                )
                if is_tool_result:
                    continue
                text = _block_text(content)
                if text.strip():
                    flush_agent()
                    turns.append({"role": "user", "text": text})
            elif kind == "assistant":
                if not isinstance(content, list):
                    continue
                if cur_agent is None:
                    cur_agent = {"role": "agent", "text": "", "ops": []}
                cur_agent["text"] += _block_text(content)
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        cur_agent["ops"].append(_tool_op(b.get("name", "")))
            # all other line kinds (queue-operation/last-prompt/custom-title/mode/attachment/system …) are meta — skip
        flush_agent()
        return turns

    def drop_session(self, subject: str, session: str) -> bool:
        """Delete a chat thread's continuity file (``.claude/sessions/<session>.session``) so a future
        turn on the same name starts a fresh conversation. The ``"main"`` thread also clears the legacy
        single-thread file (``.claude/.session``). Returns whether anything was removed. Traversal-safe:
        ``session`` is a bare name (no path separators)."""
        if "/" in session or "\\" in session or session in ("", ".", ".."):
            raise ValueError("invalid session")
        removed = False
        targets = [Path(".claude") / "sessions" / f"{session}.session",
                   Path('.claude') / 'sessions' / f'{session}.history.json']
        if session == "main":
            targets.append(Path(".claude") / ".session")
        # _continuity_roots includes only this subject's private workspace locations.
        for ws in self._continuity_roots(subject):
            for relative in targets:
                f = self._workspace_child(ws, relative)
                lexical = ws / relative
                if f is not None and lexical.exists() and lexical.is_file():
                    lexical.unlink()
                    removed = True
        return removed

    def git_state(self, subject: str) -> dict:
        """Real source-control state of the subject's OWN (primary) workspace — thin wrapper over
        ``git_state_at`` with the caller as viewer (so their own commits classify as ``you``)."""
        return self.git_state_at(self._ws(subject), viewer=subject)

    def git_state_at(self, base: Path, viewer: Optional[str] = None) -> dict:
        """Author-attributed source-control state (branch · working changes · recent commits) of the
        workspace at ``base`` — which may be the caller's own repo OR a SHARED workspace they're a member
        of (resolved+authorized by the API's ``_read_target``). Empty shape if not yet a repo.

        Each commit carries ``author`` (the committing principal's display id, stamped by the per-mount
        turn-commit — D4) and ``kind`` ∈ {``you``, ``member``, ``system``} so the terminal can surface
        OTHER members' agent pushes to a shared workspace distinctly from the viewer's own writes and from
        platform/seed plumbing. ``viewer`` (the caller's subject id) is what makes ``you`` resolvable — the
        turn-commit stamps author email ``<subject>@tina.local`` (see ``worker/engine.py`` principal)."""
        import subprocess

        from shared.gitenv import scrubbed_git_env

        base = self._guard_under_root(base)
        if not (base / ".git").exists():
            return {"branch": "", "changes": [], "commits": []}

        def git(*args: str) -> str:
            # scrubbed env: a hook-exported GIT_DIR would report the HOOK's repo, not this workspace
            return subprocess.run(
                ["git", "-C", str(base), *args], capture_output=True, text=True, env=scrubbed_git_env()
            ).stdout.strip()

        changes = []
        for line in git("status", "--porcelain").splitlines():
            if len(line) > 3:
                path = line[3:].strip()
                if path.split("/", 1)[0].lstrip(".") in ("git", "claude"):
                    continue  # hide the agent's internal .git/.claude session plumbing
                flag = line[:2].strip()[:1] or "M"
                changes.append({"path": path, "kind": "A" if flag in ("A", "?") else flag})
        viewer_email = f"{viewer}@tina.local" if viewer else None
        commits = []
        # %an·%ae carry the D4 attribution: a member's agent commit is authored as its principal
        # (name=<subject>, email=<subject>@tina.local); platform/seed commits are the plumbing authors.
        # --name-only appends each commit's changed files (so the terminal can make them clickable);
        # \x1e prefixes each commit record so we can split records and separate meta from the file list.
        # %ct = committer unix timestamp — a sortable key so a cross-workspace activity feed can merge
        # commits from several mounts by recency (the %cr relative string can't be sorted).
        raw = git("log", "-8", "--name-only", "--pretty=format:%x1e%h\x1f%s\x1f%cr\x1f%an\x1f%ae\x1f%ct")
        for rec in raw.split("\x1e"):
            rec = rec.strip("\n")
            if not rec:
                continue
            lines = rec.split("\n")
            parts = lines[0].split("\x1f")
            if len(parts) != 6:
                continue
            sha, msg, when, an, ae, ct = parts
            if ae in _SYSTEM_AUTHOR_EMAILS or an in _SYSTEM_AUTHOR_NAMES:
                kind = "system"          # policy/seed plumbing — never a member's agent push
            elif viewer_email and ae == viewer_email:
                kind = "you"             # the caller's own agent write
            else:
                kind = "member"          # ANOTHER member's agent pushed this
            files = [
                f.strip() for f in lines[1:]
                if f.strip() and f.split("/", 1)[0].lstrip(".") not in ("git", "claude")
            ][:20]                       # cap: a root/seed commit can touch hundreds
            commits.append({"sha": sha, "msg": msg, "when": when, "author": an, "kind": kind,
                            "files": files, "ts": int(ct) if ct.isdigit() else 0})
        return {"branch": git("rev-parse", "--abbrev-ref", "HEAD") or "main", "changes": changes, "commits": commits}

    def git_diff_at(self, base: Path, sha: str, path: Optional[str] = None) -> dict:
        """Unified diff of ONE commit (optionally scoped to a single file) in the workspace at ``base`` —
        so the terminal can HIGHLIGHT exactly what changed. Capped so a huge commit can't flood the UI."""
        import re
        import subprocess

        from shared.gitenv import scrubbed_git_env

        base = self._guard_under_root(base)
        if not (base / ".git").exists() or not re.fullmatch(r"[0-9a-fA-F]{4,40}", sha or ""):
            return {"sha": sha, "path": path, "diff": "", "truncated": False}  # bad sha never hits git
        args = ["git", "-C", str(base), "show", "--no-color", "--format=", sha]
        if path:
            args += ["--", path]
        out = subprocess.run(args, capture_output=True, text=True, env=scrubbed_git_env()).stdout
        lines = out.splitlines()
        return {"sha": sha, "path": path, "diff": "\n".join(lines[:600]), "truncated": len(lines) > 600}
