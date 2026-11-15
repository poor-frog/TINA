"""Bounded Vietnamese retrieval views; originals remain the only citable evidence."""
from collections import Counter
from functools import lru_cache
import json
import logging
import math
from pathlib import Path
import re
import unicodedata

STOP = set('ai là và của cho có thì mà với một những các được đang đã sẽ này đó ơi tina em anh chị tôi bạn về trong khi gì sao nào the a an is are was were to for of in on and what who when please'.split())
NEGATION = {'không', 'chưa', 'chẳng', 'not', 'never', 'no'}
DEFAULT_DOMAIN = {'asr': ['speech to text', 'nhận dạng giọng nói'],
    'postgresql': ['postgres', 'postgre sql'], 'demo': ['đề mô'], 'backend': ['back end'],
    'deadline': ['hạn bàn giao', 'hạn chót'], 'tts': ['text to speech', 'tổng hợp giọng nói']}


def terms(text):
    return [w for w in re.findall(r'\w+', unicodedata.normalize('NFKC', text).casefold()) if w not in STOP]


@lru_cache(maxsize=2048)
def vietnamese_terms(text):
    from underthesea import word_tokenize
    segmented = word_tokenize(unicodedata.normalize('NFKC', text), format='text')
    return tuple(w for w in re.findall(r'\w+', segmented.casefold()) if w not in STOP)


def domain_dictionary(base=None):
    """An invalid optional workspace dictionary must not disable retrieval."""
    try:
        return _domain_dictionary(base)
    except (OSError, ValueError, RecursionError):
        logging.getLogger(__name__).warning('Invalid optional retrieval dictionary; using built-in aliases')
        return dict(DEFAULT_DOMAIN)


def _domain_dictionary(base):
    """Workspace-local data can add spelling matches, never tools, paths or source authority."""
    result = dict(DEFAULT_DOMAIN)
    if base is None: return result
    path = Path(base) / 'retrieval-domain.json'
    if not path.exists(): return result
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 32768:
        raise ValueError('Invalid retrieval dictionary file')
    body = json.loads(path.read_text())
    if not isinstance(body, dict) or set(body) != {'version', 'aliases'} or body['version'] != 1:
        raise ValueError('Invalid retrieval dictionary')
    aliases = body['aliases']
    if not isinstance(aliases, dict) or len(aliases) > 128: raise ValueError('Too many retrieval aliases')
    for canonical, values in aliases.items():
        if (not isinstance(canonical, str) or not 1 <= len(canonical) <= 64
                or not isinstance(values, list) or not 1 <= len(values) <= 8
                or any(not isinstance(v, str) or not 1 <= len(v) <= 64 for v in values)):
            raise ValueError('Invalid retrieval alias')
        if any(not terms(v) or v.casefold().strip() in NEGATION or v.strip().isdigit()
               for v in [canonical, *values]): raise ValueError('Numeric/negation alias is forbidden')
        numeric = set(re.findall(r'\d+', canonical))
        if any(set(re.findall(r'\d+', v)) != numeric or set(re.findall(r'\w+', v.casefold())) & NEGATION
               for v in [canonical, *values]): raise ValueError('Alias cannot change numbers or negation')
        result[canonical] = values
    return result


def alias_view(text, dictionary):
    # Matching changes a search view only; quote text, names, numbers and revisions are never rewritten.
    value = unicodedata.normalize('NFKC', text).casefold()
    matches = {}
    for canonical, variants in dictionary.items():
        for variant in [canonical, *variants]: matches.setdefault(variant.casefold(), canonical.casefold())
    pattern = '|'.join(re.escape(v) for v in sorted(matches, key=len, reverse=True))
    if not pattern: return value
    return re.sub(r'(?<!\w)(?:' + pattern + r')(?!\w)', lambda m: matches[m[0]], value)


def bm25(query, documents):
    counts = [Counter(words) for words in documents]
    lengths = [sum(c.values()) for c in counts]; average = sum(lengths) / max(1, len(lengths)) or 1
    scores = [0.0] * len(counts)
    for word in sorted(set(query)):
        frequency = sum(word in c for c in counts)
        inverse = math.log(1 + (len(counts) - frequency + .5) / (frequency + .5))
        for i, count in enumerate(counts):
            n = count[word]
            if n: scores[i] += inverse * n * 2.2 / (n + 1.2 * (.25 + .75 * lengths[i] / average))
    return scores


def fold(word):
    return ''.join(c for c in unicodedata.normalize('NFD', word.casefold().replace('đ', 'd'))
                   if not unicodedata.combining(c))


def character_scores(question, documents):
    def grams(word): return {word[i:i+3] for i in range(len(word)-2)}
    query = [grams(fold(w)) for w in terms(question) if 5 <= len(w) <= 64 and w.isalpha() and w not in NEGATION][:8]
    scores = []
    for text in documents:
        words = [grams(fold(w)) for w in terms(text) if 5 <= len(w) <= 64 and w.isalpha() and w not in NEGATION]
        total = sum(max((len(q & w) / len(q | w) for w in words), default=0) for q in query)
        scores.append(total / len(query) if query else 0)
    return scores


def lexical_rankings(question, sources, *, dictionary=None, version='v2'):
    texts = [s['quote'] for s in sources]
    raw = bm25(terms(question), [terms(t) for t in texts])
    def ranking(scores, minimum=0):
        return sorted((i for i, score in enumerate(scores) if score > minimum), key=lambda i: (-scores[i], i))[:16]
    if version == 'v1': return {'raw': ranking(raw)}, raw, False
    try:
        vi = bm25(vietnamese_terms(question), [vietnamese_terms(t) for t in texts]); segmented = True
    except (ImportError, OSError, RuntimeError):
        vi = raw; segmented = False
    dictionary = DEFAULT_DOMAIN if dictionary is None else dictionary
    aliases = bm25(terms(alias_view(question, dictionary)), [terms(alias_view(t, dictionary)) for t in texts])
    fuzzy = character_scores(question, texts)
    return {'raw': ranking(raw), 'vietnamese': ranking(vi), 'alias': ranking(aliases),
            'character': ranking(fuzzy, .55)}, raw, segmented


def weighted_rrf(rankings):
    # Raw and segmented BM25 share the lexical budget; adding channels does not double it.
    weights = {'raw': .20, 'vietnamese': .20, 'alias': .08, 'character': .02, 'semantic': .50}
    scores = {}
    for channel, ranking in rankings.items():
        for rank, index in enumerate(dict.fromkeys(ranking)):
            scores[index] = scores.get(index, 0) + weights[channel] / (61 + rank)
    return scores
