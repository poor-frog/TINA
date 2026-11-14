# Transcript Rendering

## Why

Real-time transcript WebSocket streams produce overlapping, out-of-order, duplicate segments. Multiple speakers talk simultaneously, ASR engines emit draft-then-confirmed rewrites, and network jitter delivers segments out of order. Without a processing pipeline, rendering this raw data produces garbled, duplicated text.

## What

This library transforms raw `TranscriptSegment[]` streams into clean, speaker-grouped `SegmentGroup[]` output ready for rendering.

### Data Flow

```
WebSocket / REST segments
        │
        ▼
  upsertSegments()        merge into Map, handle draft→confirmed
        │
        ▼
  sortSegments()          order by absolute_start_time
        │
        ▼
  deduplicateSegments()   remove overlaps, expansions, tail-repeats (per-speaker)
        │
        ▼
  groupSegments()         consecutive same-speaker segments → SegmentGroup[]
        │
        ▼
  SegmentGroup[]          ready to render
```

### Exports

| Export | Signature | Description |
|--------|-----------|-------------|
| `upsertSegments` | `(existing: Map<string, T>, incoming: T[]) => Map<string, T>` | Merge incoming segments into a map; handles draft→confirmed transitions |
| `sortSegments` | `(segments: T[]) => T[]` | Sort segments by `absolute_start_time` (ISO string comparison) |
| `deduplicateSegments` | `(segments: T[]) => T[]` | Speaker-aware dedup: adjacent duplicates, containment, expansion, tail-repeats |
| `groupSegments` | `(segments: T[], options?: GroupingOptions) => SegmentGroup<T>[]` | Group consecutive same-key segments; splits at `maxCharsPerGroup` boundaries |
| `parseUTCTimestamp` | `(timestamp: string) => Date` | Parse ISO timestamps as UTC (appends `Z` when no timezone suffix) |
| `formatTranscript` | `(original: string, completed?: boolean, sourceParts?: readonly string[]) => FormattedTranscript` | Conservative final-text display projection with exact original offsets |
| `TranscriptSegment` | type | Input segment interface |
| `SegmentGroup` | type | Output grouped segments |
| `GroupingOptions` | type | Grouping configuration |

### Final Vietnamese display formatting

`formatTranscript` returns `{original, text, changes, version: 'vi-display.v1'}` without modifying
the segment or its identity/timestamps. Each change records original character offsets, original
and replacement text and its kind (`number`, `date`, `time`, `phone`, `technical`). Drafts passed
with `completed=false` and texts over 50000 characters are unchanged. Callers apply formatting
per finalized ASR segment, before grouping; bilingual phrase groups pass their source member parts
so formatting cannot construct a number from separate ASR turns. Mismatched member text stays raw.

The initial deterministic rules cover explicit quantities/percent/currency/counts, valid
`ngày … tháng … [năm …]`, contextual `lúc … giờ …` (including rưỡi and explicit morning/afternoon),
digit-by-digit phones explicitly introduced as điện thoại (including leading zero and explicit
cộng/+), version numbers after known technical names plus `phiên bản`, and explicitly separated
`mã …` with literal/explicitly cased letters and digit sequences. Relative dates are not resolved;
unsupported approximate/subtractive times and invalid dates remain raw. Incomplete/ambiguous phones
are not padded, and O/0 or I/1/case are not guessed. URLs, email, inline/fenced code and contested
transcript markup are protected. Ambiguous numeric separators/year phrases stay raw.

Terminal and Extension import the same pure formatter source from this package. The UI displays
only the formatted final copy; the original remains in the source data and formatter result.
Stored canonical ASR, citations, fingerprints, translation
source matching, RAG/LLM verification and audio offsets remain untouched. This is display ITN,
not ASR correction or proof of a speaker's intended phone/code. New vocabularies need explicit
rules and held-out audio testing rather than an unconstrained LLM rewrite.

### TranscriptSegment Fields

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Segment text content |
| `speaker` | `string?` | Speaker name or identifier |
| `absolute_start_time` | `string` | ISO timestamp of segment start |
| `absolute_end_time` | `string` | ISO timestamp of segment end |
| `completed` | `boolean?` | Whether the segment is finalized (vs. draft) |
| `segment_id` | `string?` | Stable identity (e.g., `speakerA:3`) |
| `start_time` | `number?` | Relative start time in seconds |
| `end_time` | `number?` | Relative end time in seconds |
| `updated_at` | `string?` | ISO timestamp of last update |

### GroupingOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `getGroupKey` | `(segment: TranscriptSegment) => string` | Groups by `speaker` | Returns the grouping key for a segment |
| `maxCharsPerGroup` | `number` | `512` | Maximum characters per group before splitting at segment boundaries |

## How

### Install & Build

```bash
cd packages/transcript-rendering
npm install
npm run build      # Build with tsup (ESM + CJS)
npm test           # Run tests with vitest
npm run typecheck  # Type-check without emitting
```

### Usage

```typescript
import {
  upsertSegments,
  sortSegments,
  deduplicateSegments,
  groupSegments,
  type TranscriptSegment,
} from '@tina/transcript-rendering';

// Maintain a segment map across WebSocket messages
const segments = new Map<string, TranscriptSegment>();

ws.on('message', (data) => {
  const incoming: TranscriptSegment[] = JSON.parse(data);

  // Full pipeline: upsert → sort → dedup → group
  upsertSegments(segments, incoming);
  const sorted = sortSegments([...segments.values()]);
  const deduped = deduplicateSegments(sorted);
  const groups = groupSegments(deduped);

  // Each group has: key (speaker), combinedText, startTime, endTime, segments[]
  render(groups);
});
```

### Package

Published as `@tina/transcript-rendering`. Dual ESM/CJS output via tsup. Apache-2.0 license.
