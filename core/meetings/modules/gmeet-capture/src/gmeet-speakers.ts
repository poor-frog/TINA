/**
 * Google Meet speaker detection — THE shared HINT emitter.
 *
 * Pure browser code (no Node, no Playwright imports). Consumed by BOTH:
 *  - the bot: bundled into browser-utils.global.js, instantiated in-page by
 *    googlemeet/recording.ts; its onSpeaking hints feed recordMixedHint().
 *  - the extension: imported directly by tina-extension/src/inpage.ts; its
 *    onSpeaking hints become `speaker_activity` (dom-active) WS messages.
 *
 * SoC: this module extracts RAW SIGNALS only — it reads who Meet is visibly
 * rendering as speaking, emits debounced start/stop HINTS per name, and exposes
 * litNames() (who is lit now). It NEVER itself attaches a name to audio. Two
 * consumers use the signal:
 *  - gmeet (capture.v1): gmeet-capture-v1 stamps the lit name onto each audio
 *    chunk AT THE SOURCE — binding identity to audio, not to a segment.
 *  - mixed (zoom/teams): the downstream ClusterNameBinder resolves clusters to
 *    these `dom-active` hints (cluster-vote, hysteresis), cross-validated vs audio.
 *
 * Speaking detection — NO auto-learn:
 *  The previous self-healing "learn a CSS class after the known ones go silent
 *  10s" heuristic was REMOVED. It mislearned a busy non-speaking class and stuck
 *  every channel to one name (the all-one-speaker collapse). Obfuscated class
 *  matching is a known-bad foundation we're replacing. For now detection uses the
 *  known classes ONLY (no learning ⇒ worst case a tile reads as not-speaking and
 *  stays provisional `ch-N`, never *wrongly* named). `probeDom()` dumps the live
 *  DOM structure so the robust, non-obfuscated signal can be designed from real
 *  data (audio-element ↔ participant-id linkage, aria/role speaking markers).
 */

export interface GmeetSpeakersOptions {
  /** Local participant's display name (bot name / data-self-name). Excluded from candidates. */
  selfName?: string;
  /** Debounced speaking state change for a NON-self named tile.
   *  isEnd=false → started speaking; isEnd=true → stopped. */
  onSpeaking?: (name: string, isEnd: boolean) => void;
  /** The LOCAL participant's display name, reported once it is observed on a self tile
   *  (the data-self-name marker can render late). Lets the channel binder pin a sticky
   *  self name it refuses to bind to any remote channel — the leak-proof backstop. */
  onSelf?: (name: string) => void;
  /** Log sink (defaults to console.log). */
  log?: (msg: string) => void;
  /** Poll interval (ms). Default 250. */
  pollMs?: number;
  /** Short linger window (ms) after a single uncontested glow ends to cover poll/onset jitter. Default 600. */
  lingerMs?: number;
  /** Clock (epoch ms), injectable for deterministic tests. Default Date.now. */
  now?: () => number;
}

export interface GmeetTileInfo {
  id: string;
  name: string | null;
  self: boolean;
  speaking: boolean;
  presenting?: boolean;
  effects?: boolean;
}

export interface GmeetResolvedSpeaker {
  name: string;
  participantId?: string;
  via: 'glow' | 'linger' | 'sole-participant';
}

export interface GmeetSpeakersState {
  tiles: GmeetTileInfo[];
  speakingNow: string[];
  participantCount: number;
  selectorStats: {
    knownClassHits: Record<string, number>;
    lastKnownHitMs: number;
  };
}

export interface GmeetSpeakers {
  getState(): GmeetSpeakersState;
  /** Names lit RIGHT NOW (non-self, named), from the poll-maintained set — O(1),
   *  no DOM re-scan. The capture.v1 binder reads this per audio chunk to stamp the
   *  glow name at the chunk's capture time. Still RAW signal extraction: it reports
   *  who Meet renders as speaking; it does not itself attach a name to audio. */
  litNames(): string[];
  /** Unambiguous speaker attribution for the current instant:
   *  1) single glowing remote tile ('glow'),
   *  2) never guesses during multi-tile overlap (returns undefined),
   *  3) brief uncontested linger after a single glow ends ('linger'),
   *  4) sole remote participant in a 1-on-1 room when glow classes miss ('sole-participant'). */
  resolvedSpeaker(nowMs?: number): GmeetResolvedSpeaker | undefined;
  /** Sole remote participant when the room contains exactly one non-self, non-effects human. */
  soleRemoteSpeaker(): { name: string; participantId?: string } | undefined;
  /** A unique observed participant for this display label; ambiguity stays unresolved. */
  participantForName(name: string): string | undefined;
  /** One-shot structural dump of the live Meet DOM — for designing a robust,
   *  non-obfuscated speaking/naming signal. Read-only; no side effects. */
  probeDom(): GmeetDomProbe;
  destroy(): void;
}

/** What probeDom() returns: enough of the live structure to decide whether
 *  channel↔name can be STRUCTURAL (audio element carries a participant id) or
 *  needs a SEMANTIC (aria/role) speaking signal instead of obfuscated classes. */
export interface GmeetDomProbe {
  audioCount: number;
  /** Per media element carrying audio: the co-location test — does it sit inside a
   *  tile that carries a participant id + name, and is that tile currently glowing
   *  (speaking)? If participantId/tileName are populated AND `speaking` tracks who
   *  is actually talking, audio→name is a DIRECT structural read (no timing). */
  audio: { tag: string; hasAudioTrack: boolean; trackId: string | null; participantId: string | null; tileName: string | null; speaking: boolean }[];
  tileCount: number;
  tiles: { id: string; name: string | null; speaking: boolean; aria: string | null }[];
  /** Names the DOM currently shows as speaking (glow), for cross-check. */
  speakingNow: string[];
}

const PARTICIPANT_SELECTORS = ['div[data-participant-id]', '[data-participant-id]'];
const NAME_SELECTORS = [
  'span.notranslate',
  '.zWGUib',
  '.cS7aqe.N2K3jd',
  '.XWGOtd',
  '.participant-name',
  '.display-name',
];
const KNOWN_SPEAKING_CLASSES = [
  'Oaajhc', 'HX2H7', 'wEsLMd', 'OgVli',
  'speaking', 'active-speaker', 'speaker-active', 'speaking-indicator',
];
const JUNK_NAME = /^Google Participant \(|spaces\/|devices\//;
const JUNK_PHRASES = ['let participants', 'send messages', 'turn on captions'];
const EFFECTS_TILE = /visual_effects|backgrounds and effects/i;
const PRESENTING_SUFFIX = /\s*(?:\((?:presenting|presentation|đang trình bày)\)|(?:is presenting|đang trình bày))\s*$/i;

export function createGmeetSpeakers(opts: GmeetSpeakersOptions = {}): GmeetSpeakers {
  const pollMs = opts.pollMs ?? 250;  // responsive: track the visible active-speaker glow closely
  const lingerMs = opts.lingerMs ?? 600;
  const now = opts.now ?? (() => Date.now());

  const knownClassHits: Record<string, number> = {};
  let lastKnownHitMs = now();

  /** Names currently lit (non-self, named) — drives start/stop hint edges. */
  const speakingNow = new Set<string>();
  const reportedSelf = new Set<string>();   // self names already reported via onSelf (fire once each)
  const selfNamesLower = new Set<string>();
  if (opts.selfName?.trim()) selfNamesLower.add(opts.selfName.trim().toLowerCase());
  let lastSingleGlow: { name: string; participantId?: string; ts: number } | null = null;

  // ── DOM reading ─────────────────────────────────────────────────

  function normalizeTileLabel(raw: string): { name: string | null; presenting: boolean } {
    let t = raw.trim();
    if (!t) return { name: null, presenting: false };
    const presenting = PRESENTING_SUFFIX.test(t);
    if (presenting) t = t.replace(PRESENTING_SUFFIX, '').trim();
    if (!t || t.length < 2 || t.length > 50) return { name: null, presenting };
    if (JUNK_NAME.test(t)) return { name: null, presenting };
    const lower = t.toLowerCase();
    if (JUNK_PHRASES.some(p => lower.includes(p))) return { name: null, presenting };
    return { name: t, presenting };
  }

  function readTileName(el: HTMLElement): { name: string | null; presenting: boolean } {
    for (const sel of NAME_SELECTORS) {
      const node = el.querySelector(sel) as HTMLElement | null;
      const raw = node?.textContent?.trim() || '';
      if (raw) {
        const parsed = normalizeTileLabel(raw);
        if (parsed.name) return parsed;
      }
    }
    const labeled = (el.hasAttribute('data-self-name') ? el : el.querySelector('[data-self-name]')) as HTMLElement | null;
    const selfAttr = labeled?.getAttribute('data-self-name')?.trim() || '';
    if (selfAttr) return normalizeTileLabel(selfAttr);
    return { name: null, presenting: false };
  }

  function tileName(el: HTMLElement): string | null {
    return readTileName(el).name;
  }

  function isEffectsTile(el: HTMLElement): boolean {
    const label = el.getAttribute('aria-label') || el.textContent || '';
    return EFFECTS_TILE.test(label);
  }

  // The local participant's tile(s), located via Meet's OWN structural marker
  // (data-self-name). Re-read every scan — the self tile can render late or move,
  // and the marker may sit on a child or sibling of the participant tile.
  function selfParticipantIds(): Set<string> {
    const ids = new Set<string>();
    document.querySelectorAll('[data-self-name]').forEach(marker => {
      const tile = (marker as HTMLElement).closest('[data-participant-id]') as HTMLElement | null;
      const pid = tile?.getAttribute('data-participant-id');
      if (pid) ids.add(pid);
    });
    return ids;
  }

  // Self/host detection combines Meet's structural data-self-name marker with a sticky
  // selfName backstop (configured bot name or previously observed self tile name) so
  // transient drops of data-self-name never allow the bot's own tile to compete with speakers.
  function isSelf(el: HTMLElement, id: string, selfIds: Set<string>, name: string | null): boolean {
    if (el.hasAttribute('data-self-name') || !!el.querySelector('[data-self-name]') || selfIds.has(id)) {
      return true;
    }
    if (name && selfNamesLower.has(name.toLowerCase())) return true;
    return false;
  }

  function tileSpeaking(el: HTMLElement): boolean {
    // Semantic audio-level attribute first — survives Google Meet CSS class rotation.
    const audioEl = (el.hasAttribute('data-audio-level') ? el : el.querySelector('[data-audio-level]')) as HTMLElement | null;
    if (audioEl) {
      const raw = audioEl.getAttribute('data-audio-level');
      const level = raw !== null && raw !== '' ? Number(raw) : 0;
      if (Number.isFinite(level) && level > 0) {
        knownClassHits['data-audio-level'] = (knownClassHits['data-audio-level'] || 0) + 1;
        lastKnownHitMs = now();
        return true;
      }
    }
    for (const cls of KNOWN_SPEAKING_CLASSES) {
      if (el.classList.contains(cls) || el.querySelector('.' + CSS.escape(cls))) {
        knownClassHits[cls] = (knownClassHits[cls] || 0) + 1;
        lastKnownHitMs = now();
        return true;
      }
    }
    return false;
  }

  function scanTiles(): GmeetTileInfo[] {
    const out: GmeetTileInfo[] = [];
    const seen = new Set<string>();
    const selfIds = selfParticipantIds();
    for (const sel of PARTICIPANT_SELECTORS) {
      document.querySelectorAll(sel).forEach(node => {
        const el = node as HTMLElement;
        const id = el.getAttribute('data-participant-id') || '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        const { name, presenting } = readTileName(el);
        const aria = el.getAttribute('aria-label') || '';
        const isPresenting = presenting || /\bpresentation\b|\bpresenting\b/i.test(id) || /\bpresenting\b|\bpresentation\b/i.test(aria);
        const self = isSelf(el, id, selfIds, name);
        const effects = !self && isEffectsTile(el);
        out.push({ id, name, self, speaking: tileSpeaking(el), presenting: isPresenting, effects });
      });
    }
    return out;
  }

  // ── Main loop: emit start/stop HINTS on edge changes ─────────────

  let observedTiles: GmeetTileInfo[] = [];

  function resolveParticipantId(tiles: GmeetTileInfo[], name: string): string | undefined {
    const matches = tiles.filter(t => !t.self && !t.effects && t.name === name);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      const uniqueIds = new Set(matches.map(t => t.id));
      if (uniqueIds.size === 1) return matches[0].id;
      // Same person with camera tile + presentation tile: prefer the unique non-presenting tile.
      const primary = matches.filter(t => !t.presenting);
      if (primary.length === 1 && matches.some(t => t.presenting)) return primary[0].id;
    }
    return undefined;
  }

  function computeSoleRemote(tiles: GmeetTileInfo[]): { name: string; participantId?: string } | undefined {
    const remote = tiles.filter(t => !t.self && !t.effects);
    if (remote.length === 0) return undefined;
    // If any non-presenting remote tile is unnamed, another real participant may be present — never guess.
    if (remote.some(t => !t.name && !t.presenting)) return undefined;
    const named = remote.filter(t => !!t.name);
    const uniqueNames = new Set(named.map(t => t.name as string));
    if (uniqueNames.size !== 1) return undefined;
    const onlyName = [...uniqueNames][0];
    const participantId = resolveParticipantId(tiles, onlyName);
    // If two distinct non-presenting people share the same display name, participantId is undefined — refuse.
    const primaryMatches = named.filter(t => !t.presenting);
    const distinctPrimaryIds = new Set(primaryMatches.map(t => t.id));
    if (distinctPrimaryIds.size > 1) return undefined;
    return { name: onlyName, participantId };
  }

  const timer = setInterval(() => {
    const tiles = scanTiles();
    observedTiles = tiles;

    // Report the self/host name (once) so the binder can pin it as never-bindable —
    // the data-self-name marker can render late, so we watch every scan, not just start.
    for (const t of tiles) {
      if (t.self && t.name) {
        selfNamesLower.add(t.name.toLowerCase());
        if (!reportedSelf.has(t.name)) {
          reportedSelf.add(t.name);
          try { opts.onSelf?.(t.name); } catch { /* consumer error */ }
        }
      }
    }

    // Currently-lit, non-self, non-effects, named tiles.
    const litNow = new Set<string>(
      tiles.filter(t => !t.self && !t.effects && t.speaking && t.name).map(t => t.name as string),
    );

    if (litNow.size === 1) {
      const only = [...litNow][0];
      lastSingleGlow = { name: only, participantId: resolveParticipantId(tiles, only), ts: now() };
    } else if (litNow.size > 1) {
      // Multi-speaker overlap invalidates linger immediately so overlap never inherits a stale name.
      lastSingleGlow = null;
    }

    // Newly lit → SPEAKER_START hint.
    for (const name of litNow) {
      if (!speakingNow.has(name)) {
        speakingNow.add(name);
        try { opts.onSpeaking?.(name, false); } catch { /* consumer error */ }
      }
    }
    // Went quiet → SPEAKER_END hint.
    for (const name of [...speakingNow]) {
      if (!litNow.has(name)) {
        speakingNow.delete(name);
        try { opts.onSpeaking?.(name, true); } catch { /* consumer error */ }
      }
    }
  }, pollMs);

  return {
    getState(): GmeetSpeakersState {
      const tiles = scanTiles();
      return {
        tiles,
        speakingNow: tiles.filter(t => !t.self && !t.effects && t.speaking && t.name).map(t => t.name as string),
        participantCount: tiles.length,
        selectorStats: { knownClassHits: { ...knownClassHits }, lastKnownHitMs },
      };
    },
    litNames(): string[] { return [...speakingNow]; },
    soleRemoteSpeaker(): { name: string; participantId?: string } | undefined {
      return computeSoleRemote(observedTiles);
    },
    resolvedSpeaker(nowMs?: number): GmeetResolvedSpeaker | undefined {
      if (speakingNow.size === 1) {
        const only = [...speakingNow][0];
        return { name: only, participantId: resolveParticipantId(observedTiles, only), via: 'glow' };
      }
      if (speakingNow.size > 1) return undefined;
      const t = nowMs ?? now();
      if (lastSingleGlow && t - lastSingleGlow.ts <= lingerMs) {
        return { name: lastSingleGlow.name, participantId: lastSingleGlow.participantId, via: 'linger' };
      }
      const sole = computeSoleRemote(observedTiles);
      if (sole) return { ...sole, via: 'sole-participant' };
      return undefined;
    },
    participantForName(name): string | undefined {
      return resolveParticipantId(observedTiles, name);
    },
    probeDom(): GmeetDomProbe {
      // The captured elements are <audio> AND <video> with audio tracks (same set
      // gmeet-capture taps). For each, run the co-location test against its tile.
      const media = (Array.from(document.querySelectorAll('audio, video')) as HTMLMediaElement[])
        .filter(el => el.srcObject instanceof MediaStream && (el.srcObject as MediaStream).getAudioTracks().length > 0);
      const tiles = Array.from(document.querySelectorAll('[data-participant-id]')) as HTMLElement[];
      return {
        audioCount: media.length,
        audio: media.slice(0, 16).map(a => {
          let track: string | null = null;
          try { track = (a.srcObject as MediaStream | null)?.getAudioTracks?.()[0]?.id?.slice(0, 12) || null; } catch { /* */ }
          const tile = (a.getAttribute('data-participant-id') ? a : a.closest('[data-participant-id]')) as HTMLElement | null;
          return {
            tag: a.tagName.toLowerCase(),
            hasAudioTrack: true,
            trackId: track,
            participantId: (tile?.getAttribute('data-participant-id') || a.parentElement?.getAttribute('data-participant-id') || null)?.slice(0, 16) || null,
            tileName: tile ? tileName(tile) : null,
            speaking: tile ? tileSpeaking(tile) : false,
          };
        }),
        tileCount: tiles.length,
        tiles: tiles.slice(0, 16).map(t => ({
          id: (t.getAttribute('data-participant-id') || '').slice(0, 16),
          name: tileName(t),
          speaking: tileSpeaking(t),
          aria: t.getAttribute('aria-label') || null,
        })),
        speakingNow: tiles.filter(t => !t.hasAttribute('data-self-name') && tileSpeaking(t) && tileName(t)).map(t => tileName(t) as string),
      };
    },
    destroy(): void {
      clearInterval(timer);
    },
  };
}
