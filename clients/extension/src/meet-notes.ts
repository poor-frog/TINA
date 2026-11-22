import type { BotProcessedNote } from './bot-transcript';

export interface NoteGroup {
  title: string;
  notes: BotProcessedNote[];
}

export function noteTime(seconds: number): string {
  if (seconds >= 1_000_000_000) return new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function recapGroups(notes: BotProcessedNote[]): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const note of [...notes].sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))) {
    const title = note.chapter?.trim() || 'Ghi chú chung';
    let group = groups.get(title);
    if (!group) {
      group = { title, notes: [] };
      groups.set(title, group);
    }
    group.notes.push(note);
  }
  return [...groups.values()];
}

export function recapText(groups: NoteGroup[]): string {
  return groups.flatMap(group => {
    const items = group.notes.filter(note => !note.stale && !note.withdrawn).map(note => {
      const label = [note.t == null ? '' : noteTime(note.t), note.speaker].filter(Boolean).join(' · ');
      return `- ${label ? `[${label}] ` : ''}${note.text}`;
    });
    return items.length ? [[group.title, ...items].join('\n')] : [];
  }).join('\n\n');
}

export interface NotesPreview {
  groups: NoteGroup[];
  bounded: boolean;
}

export function notesPreview(body: unknown, meetingId: number): NotesPreview {
  const value = body as {
    notes_preview?: unknown;
    meeting_id?: unknown;
    claims?: { text: string; source_ids: string[] }[];
    sources?: { id: string; segment_id?: string; start_ms?: number }[];
    coverage?: { bounded: boolean };
  } | null;
  if (value?.notes_preview !== true || value.meeting_id !== meetingId || !Array.isArray(value.claims)
    || value.claims.length > 4 || !Array.isArray(value.sources) || typeof value.coverage?.bounded !== 'boolean')
    throw new Error('TINA trả về bản tóm tắt không hợp lệ.');
  const sources = new Map(value.sources.filter(source => source && typeof source.id === 'string'
    && typeof source.segment_id === 'string' && !!source.segment_id && typeof source.start_ms === 'number'
    && Number.isFinite(source.start_ms) && source.start_ms >= 0).map(source => [source.id, source]));
  const notes = value.claims.map((claim, index) => {
    const source = claim && Array.isArray(claim.source_ids) && sources.get(claim.source_ids[0]);
    if (!source || typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > 1600)
      throw new Error('Một ý trong bản tóm tắt chưa có nguồn xác nhận.');
    return { id: String(index), text: claim.text, segmentId: source.segment_id,
      t: source.start_ms! / 1000, stale: false, withdrawn: false };
  });
  return { groups: notes.length ? [{ title: 'Ý chính', notes }] : [], bounded: value.coverage.bounded };
}
