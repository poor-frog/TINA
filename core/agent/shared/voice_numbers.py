"""Conservative comparison facts only; never rewrite source quotes or spoken answers."""
from fractions import Fraction
import re
import unicodedata

DIGITS = dict(zip('không một hai ba bốn năm sáu bảy tám chín'.split(), range(10)))
DIGITS.update(mốt=1, tư=4, lăm=5)
SCALES = {'nghìn':1000, 'ngàn':1000, 'triệu':10**6, 'tỷ':10**9, 'tỉ':10**9}
STRUCTURAL = {'mười','mươi','trăm','phẩy',*SCALES}
WORDS = '|'.join(sorted({*DIGITS,*STRUCTURAL,'linh','lẻ'}, key=lambda word: (-len(word),word)))
QUANTITY = re.compile(
    r'(?<!\w)(?P<sign>[+−-]|(?:âm|dương)[^\S\r\n]+)?'
    r'(?P<amount>\d+(?:[.,:/-]\d+)*|(?:'+WORDS+r')(?:[^\S\r\n]+(?:'+WORDS+r'))*)'
    r'(?P<scale>[^\S\r\n]+(?:nghìn|ngàn|triệu|tỷ|tỉ)\b)?'
    r'(?P<unit>[^\S\r\n]*(?:phần[^\S\r\n]+trăm\b|%|đô[^\S\r\n]+la\b|usd\b|vnd\b|vnđ\b|đồng\b|eur\b|euro\b))?'
    r'(?!\w)')
UNITS = {'phần trăm':'percent', '%':'percent', 'đô la':'usd', 'usd':'usd',
         'vnd':'vnd', 'vnđ':'vnd', 'đồng':'vnd', 'eur':'eur', 'euro':'eur'}
COUNT = re.compile(r'[^\S\r\n]+(?:đứa|người|cái|chiếc|cấp|lần)\b')


def _small(words):
    value = 0; separated = False
    if len(words)>=2 and words[0] in DIGITS and words[1]=='trăm':
        value = DIGITS[words[0]]*100; words = words[2:]
        if words and words[0] in ('linh','lẻ'):
            words = words[1:]; separated = True
            if not words: raise ValueError('Incomplete cardinal')
    if not words: return value
    if words[0]=='mười':
        value += 10; words = words[1:]
    elif len(words)>=2 and words[0] in DIGITS and DIGITS[words[0]]>=2 and words[1]=='mươi':
        value += DIGITS[words[0]]*10; words = words[2:]
    if words:
        if len(words)!=1 or words[0] not in DIGITS: raise ValueError('Ambiguous cardinal')
        if words[0]=='năm' and value and not separated: raise ValueError('Year or cardinal')
        value += DIGITS[words[0]]
    return value


def _integer(words):
    total, group, previous = 0, [], 10**12
    for word in words:
        if word not in SCALES:
            group.append(word); continue
        scale = SCALES[word]
        if not group or scale>=previous: raise ValueError('Ambiguous scale')
        total += _small(group)*scale; group = []; previous = scale
    if group: total += _small(group)
    return total


def _words(amount):
    parts = amount.split(' phẩy ')
    if len(parts)>2: raise ValueError('Ambiguous decimal')
    value = Fraction(_integer(parts[0].split()))
    if len(parts)==2:
        digits = parts[1].split()
        scale = SCALES[digits.pop()] if digits and digits[-1] in SCALES else 1
        if not digits or any(word not in DIGITS for word in digits): raise ValueError('Ambiguous decimal')
        value += Fraction(int(''.join(str(DIGITS[word]) for word in digits)),10**len(digits))
        value *= scale
    return value


def numeric_facts(text):
    text = unicodedata.normalize('NFKC',text).casefold()
    facts = set()
    for match in QUANTITY.finditer(text):
        amount = match['amount']; unit = ' '.join((match['unit'] or '').split())
        if not amount[0].isdigit() and amount.split()[0] not in {*DIGITS,'mười'}: continue
        if not amount[0].isdigit() and not (STRUCTURAL.intersection(amount.split()) or unit
                or COUNT.match(text[match.end():])):
            continue  # Bare “không”/“năm” may mean negation/year, not a quantity.
        try:
            if amount[0].isdigit():
                # shortcut: ambiguous separators/dates/version sequences stay literal; add locale evidence before widening.
                if not re.fullmatch(r'\d+(?:[.,]\d+)?',amount) or re.search(r'[.,]\d{3}$',amount):
                    raise ValueError('Ambiguous numeric spelling')
                value = Fraction(amount.replace(',','.'))
            else: value = _words(amount)
            if match['scale']: value *= SCALES[match['scale'].strip()]
            if (match['sign'] or '').strip() in ('-','−','âm'): value = -value
            facts.add(('quantity',value,UNITS.get(unit,'')))
        except ValueError:
            facts.add(('literal',match[0].strip()))
    return facts
