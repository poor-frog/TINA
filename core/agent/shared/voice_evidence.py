"""Original-source windows and compact evidence references; no generated text becomes evidence."""


def filtered_sources(sources, filters):
    result = []
    for source in sources:
        if filters.get('speaker_id') is not None and source.get('speaker_id') != filters['speaker_id']: continue
        start, end = source.get('start_ms'), source.get('end_ms')
        if filters.get('start_ms') is not None and (type(end) not in (int, float) or end < filters['start_ms']): continue
        if filters.get('end_ms') is not None and (type(start) not in (int, float) or start > filters['end_ms']): continue
        result.append(source)
    return result


def window_indices(sources, anchor, radius=2):
    current = sources[anchor]; rows = []
    for i in range(max(0, anchor-radius), min(len(sources), anchor+radius+1)):
        other = sources[i]
        if current.get('meeting_id') != other.get('meeting_id'): continue
        same_doc = current['kind'] == other['kind'] == 'document' and current['path'] == other['path']
        near = (current['kind'] == other['kind'] == 'transcript'
                and type(current.get('end_ms')) in (int, float) and type(other.get('end_ms')) in (int, float)
                and abs(current['end_ms']-other['end_ms']) <= 30000)
        if same_doc or near: rows.append(i)
    return rows


def evidence_pack(sources, *, available):
    """Quote text appears once in the existing sources list; refs bind those exact originals."""
    return {'version': 'retrieval-evidence.v2', 'available': available, 'selected': len(sources),
            'bounded': len(sources) < available, 'quote_container': 'sources',
            'items': [{k: s[k] for k in ('id', 'key', 'fingerprint', 'kind', 'meeting_id', 'speaker_id',
                'speaker_revision', 'start_ms', 'end_ms', 'revision', 'path', 'paragraph', 'document_sha256',
                'parent_key', 'parent_fingerprint', 'char_start', 'char_end', 'retrieval') if k in s}
                for s in sources]}
