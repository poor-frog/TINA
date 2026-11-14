"""Render provider citations using recorded URLs; opaque references alone are never evidence."""
from __future__ import annotations

import re
import json
from urllib.parse import quote, unquote, urlsplit, urlunsplit

_REF = re.compile(r'turn\d+(?:search|view|fetch)\d+')
_INLINE = re.compile(
    r'(?P<ticks>`+)(?!`)[\s\S]*?(?<!`)(?P=ticks)(?!`)'
    r'|!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)'
    r'|(?P<citation>cite[^\n]*)',
)


def safe_web_source(value):
    """Validate a provider-recorded HTTP(S) citation for display; this never fetches the URL."""
    if not isinstance(value, dict) or not isinstance(value.get('url'), str):
        return None
    url = value['url']
    if len(url) > 4096 or '\\' in url or any(ord(c) < 32 or ord(c) == 127 for c in unquote(url)):
        return None
    try:
        parsed = urlsplit(url)
        if (parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname
                or parsed.username is not None or any(c.isspace() for c in parsed.netloc)):
            return None
        parsed.port  # Validate malformed and out-of-range ports before displaying a link.
    except ValueError:
        return None
    safe = "/:@!$&'*+,;=%-._~"
    url = urlunsplit((parsed.scheme, parsed.netloc, quote(parsed.path, safe=safe),
                     quote(parsed.query, safe=safe + '?'), quote(parsed.fragment, safe=safe + '?')))
    title = value.get('title')
    title = ' '.join(title.split())[:300] if isinstance(title, str) else ''
    refs = value.get('refs') if isinstance(value.get('refs'), list) else []
    refs = [*refs[:50], *(value.get(key) for key in ('ref_id', 'reference_id', 'citation_id', 'id'))]
    return {'url': url, 'title': title or (parsed.hostname + unquote(parsed.path))[:300],
            'refs': list(dict.fromkeys(ref for ref in refs if isinstance(ref, str) and _REF.fullmatch(ref)))}


def web_sources(item: dict) -> list[dict]:
    """Extract direct result URLs and opened pages from native or persisted Codex web calls."""
    if (item.get('type') in ('mcpToolCall', 'mcp_tool_call') and item.get('server') == 'tina-reach'
            and item.get('tool') in ('reach_web_search','reach_web_read','reach_github_search','reach_github_read')):
        result = item.get('result')
        if not isinstance(result, dict) or result.get('isError'):
            return []
        for block in (result.get('content') or [])[:5]:
            if not isinstance(block, dict) or block.get('type') != 'text': continue
            raw = block.get('text')
            if not isinstance(raw, str) or len(raw) > 200000: continue
            try: body = json.loads(raw)
            except ValueError: continue
            if isinstance(body, dict) and body.get('ok') is True and isinstance(body.get('items'), list):
                return [s for row in body['items'][:5] if (s := safe_web_source(row)) is not None]
        return []
    if item.get('type') not in ('webSearch', 'web_search_call'):
        return []
    results = item.get('results') if isinstance(item.get('results'), list) else []
    candidates = results[:50]
    action = item.get('action')
    if isinstance(action, dict) and action.get('type') in ('openPage', 'open_page'):
        candidates = [*candidates, action]
    return [source for value in candidates if (source := safe_web_source(value)) is not None][:50]


def render_citations(text: str, sources: list[dict]) -> str:
    """Resolve explicit references and append a bounded, source-preserving Markdown bibliography."""
    unique = {}
    for value in sources[:50]:
        source = safe_web_source(value)
        if source is None:
            continue
        if source['url'] in unique:
            previous = unique[source['url']]
            previous['refs'] = list(dict.fromkeys([*previous['refs'], *source['refs']]))
        else:
            unique[source['url']] = source
    by_ref = {}
    for source in unique.values():
        for ref in source['refs']:
            by_ref.setdefault(ref, []).append(source)

    def link(source):
        title = re.sub(r'([\\`*{}\[\]()<>_!])', r'\\\1', source['title'])
        return f"[{title}]({source['url']})"

    def replace(match):
        if not match.group('citation'):
            return match[0]
        links = []
        for ref in match[0][len('cite'):-1].split(''):
            matches = by_ref.get(ref, [])
            value = link(matches[0]) if len(matches) == 1 else '[Nguồn chưa có liên kết]'
            if value not in links:
                links.append(value)
        return ', '.join(links)

    output, prose, fence = [], [], None
    for line in text.splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fence:
            output.append(line)
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(fence[1]) + r',}[ \t]*\r?\n?', line):
                fence = None
        elif marker or line.startswith(('    ', '\t')):
            output.append(_INLINE.sub(replace, ''.join(prose)))
            prose = []
            output.append(line)
            if marker:
                fence = (marker[1][0], len(marker[1]))
        else:
            prose.append(line)
    output.append(_INLINE.sub(replace, ''.join(prose)))
    rendered = ''.join(output)
    if not unique:
        return rendered
    bibliography = 'Nguồn web đã mở/tra cứu:\n' + '\n'.join('- ' + link(source) for source in unique.values())
    return rendered if rendered.rstrip().endswith(bibliography) else rendered.rstrip() + '\n\n' + bibliography
