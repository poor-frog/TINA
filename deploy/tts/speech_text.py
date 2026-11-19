"""Deterministic spoken copy; approved project terms never modify the stored answer."""
import json
import re
from datetime import date
from functools import lru_cache
from pathlib import Path

DEFAULT_FILE = Path(__file__).with_name('pronunciations.json')
PROTECTED = re.compile(r'```[\s\S]*?```|`[^`\n]*`|https?://[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}')
NUMERIC = re.compile(
    r'(?<![\w/:-])(?:ngày\s+\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2}|'
    r'\d{1,2}/\d{1,2}|\d{1,2}:\d{2}|[+-]?\d+(?:[.,]\d+)*\s*(?:triệu|tỷ|nghìn|ngàn|đồng|VND|%)|[+-]\d+(?:[.,]\d+)*)(?![\w/:-])', re.I)
DIGITS = dict(zip('0123456789', 'không một hai ba bốn năm sáu bảy tám chín'.split()))


@lru_cache(maxsize=1)
def normalizer():
    from sea_g2p import Normalizer
    return Normalizer()


def numeric_text(match):
    value = match.group()
    if re.fullmatch(r'\d{1,2}/\d{1,2}', value):
        return ' gạch chéo '.join(' '.join(DIGITS[c] for c in part) for part in value.split('/'))
    if ':' in value:
        hour, minute = map(int, value.split(':'))
        if hour > 23 or minute > 59: return value
    if value.casefold().startswith('ngày '):
        day, month, year = map(int, re.findall(r'\d+', value))
        try: date(year, month, day)
        except ValueError: return value
    elif re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        try: date.fromisoformat(value)
        except ValueError: return value
    else:
        amount = re.match(r'[+-]?([\d.,]+)', value)
        if amount and not re.fullmatch(r'(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?', amount[1]):
            if value.startswith(('-', '+')):
                literal = ' '.join(DIGITS.get(c, 'chấm' if c == '.' else 'phẩy') for c in amount[1])
                return ('âm ' if value[0] == '-' else 'dương ') + literal + value[amount.end():]
            return value
    # The installed normalizer drops minus signs, so preserve their meaning explicitly.
    sign = 'âm ' if value.startswith('-') else 'dương ' if value.startswith('+') else ''
    return sign + normalizer().normalize(value.lstrip('+-'))


class Pronunciations:
    def __init__(self, data):
        if not isinstance(data, dict) or set(data) != {'default', 'projects', 'meeting_projects'}:
            raise ValueError('Invalid pronunciation configuration')
        def entries(items):
            if not isinstance(items, dict) or len(items) > 128: raise ValueError('Invalid pronunciation entries')
            for key, value in items.items():
                if (not isinstance(key, str) or not isinstance(value, str) or not 1 <= len(key) <= 80
                        or not 1 <= len(value) <= 120 or key != key.strip() or value != value.strip()
                        or not all(c.isalpha() or c in " -'.," for c in key + value)):
                    raise ValueError('Pronunciations require bounded words without digits or markup')
            if len({k.casefold() for k in items}) != len(items): raise ValueError('Duplicate pronunciation term')
            return items
        self.defaults = entries(data['default'])
        projects, meetings = data['projects'], data['meeting_projects']
        if not isinstance(projects, dict) or len(projects) > 32 or not isinstance(meetings, dict) or len(meetings) > 256:
            raise ValueError('Invalid project pronunciation mapping')
        self.projects = {}
        for name, items in projects.items():
            if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', name): raise ValueError('Invalid pronunciation project')
            self.projects[name] = entries(items)
        if any(not isinstance(project, str) or not re.fullmatch(r'[1-9]\d{0,17}', mid)
               or int(mid) > 9007199254740991 or project not in self.projects for mid, project in meetings.items()):
            raise ValueError('Invalid meeting pronunciation project')
        self.meetings = meetings

    def for_meeting(self, meeting_id=None):
        result = {k.casefold(): v for k, v in self.defaults.items()}
        project = self.meetings.get(str(meeting_id))
        result.update({k.casefold(): v for k, v in self.projects.get(project, {}).items()})
        return result


@lru_cache(maxsize=1)
def default_pronunciations():
    raw = DEFAULT_FILE.read_bytes()
    if len(raw) > 65536: raise ValueError('Pronunciation file exceeds bound')
    return Pronunciations(json.loads(raw))


def spoken_text(text, glossary=None):
    words = default_pronunciations().for_meeting() if glossary is None else glossary
    pattern = re.compile(r'(?<!\w)(?:' + '|'.join(re.escape(k) for k in sorted(words, key=len, reverse=True)) + r')(?!\w)', re.I) if words else None
    def rewrite(part):
        # Glossary substitutions run once, before numbers, with no cascading replacements.
        if pattern: part = pattern.sub(lambda m: words[m.group().casefold()], part)
        return NUMERIC.sub(numeric_text, part)
    output, offset = [], 0
    for match in PROTECTED.finditer(text):
        output.extend((rewrite(text[offset:match.start()]), match.group()))
        offset = match.end()
    output.append(rewrite(text[offset:]))
    value = ''.join(output)
    if len(value) > 12000: raise ValueError('Spoken copy exceeds bound')
    return value
