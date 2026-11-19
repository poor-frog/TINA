/** Core owns phrase boundaries. This projection only pairs exact source IDs/text for display. */
export interface TranslationGroup {
  group_id: string;
  members: { segment_id: string; source_text: string; revision?: number }[];
  source_text: string; translated_text: string | null; ready: boolean;
  speaker_id: string; speaker_name: string; start_ms: number; end_ms: number;
  status?: "waiting" | "pending" | "running" | "retrying" | "failed" | "complete";
  retry_after?: number; attempts?: number; error_code?: string;
}

interface SourceSegment { id?: string; text: string; completed?: boolean; tsMs?: number; speakerId?: string; revision?: number }
export interface PhraseTranslation { groupId: string; text: string | null; ready: boolean; memberIds: string[]; sourceParts?:string[]; status?: TranslationGroup['status'] }

export function projectTranslationGroups<T extends SourceSegment>(segments: T[], groups: TranslationGroup[]): (T & { translation?: PhraseTranslation })[] {
  const current = new Map(segments.filter(s => s.id).map(s => [s.id!, s]));
  const byMember = new Map<string, TranslationGroup>();
  for (const group of groups) {
    // A single edited/in-flight member invalidates the entire English phrase.
    const known = group.members.filter(member => current.has(member.segment_id));
    if (!known.length || known.some(member => {
      const segment = current.get(member.segment_id)!;
      return segment.completed === false || segment.text !== member.source_text
        || (member.revision != null && segment.revision != null && member.revision !== segment.revision)
        || !!(segment.speakerId && group.speaker_id && segment.speakerId !== group.speaker_id);
    })) continue;
    for (const member of group.members) byMember.set(member.segment_id, group);
  }
  const seen = new Set<string>();
  const result: (T & { translation?: PhraseTranslation })[] = [];
  for (const segment of segments) {
    const group = segment.id ? byMember.get(segment.id) : undefined;
    if (!group) { result.push(segment); continue; }
    if (seen.has(group.group_id)) continue;
    seen.add(group.group_id);
    result.push({ ...segment, text: group.source_text,
      tsMs: group.start_ms > 100_000_000_000 ? group.start_ms : segment.tsMs,
      translation: { groupId: group.group_id, text: group.translated_text, ready: group.ready, status: group.status,
        sourceParts:group.members.map(m=>m.source_text), memberIds: group.members.map(m => m.segment_id) } });
  }
  return result;
}
