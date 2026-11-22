export function meetAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
        && /^lh\d+\.googleusercontent\.com$/.test(url.hostname)) return url.href;
  } catch { /* an invalid URL has no avatar */ }
}

export function readMeetAvatars(root: Document, cache: Map<string, string>): [string, string][] {
  const avatars = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const image of root.querySelectorAll<HTMLImageElement>('[data-participant-id] img')) {
    if (!image.getClientRects().length) continue;
    const id = image.closest('[data-participant-id]')?.getAttribute('data-participant-id');
    const url = meetAvatarUrl(image.currentSrc || image.src);
    if (!id || id.length > 512 || !url || ambiguous.has(id)) continue;
    if (avatars.has(id) && avatars.get(id) !== url) {
      // Meet may render the same participant in several places with different image sizes.
      const withoutSize = (value: string) => value.replace(/=s\d+(?:-[a-z0-9]+)*(?=\?|$)/, '');
      if (withoutSize(avatars.get(id)!) === withoutSize(url)) continue;
      avatars.delete(id);
      ambiguous.add(id);
    } else avatars.set(id, url);
  }
  // Meet removes tiles when people leave. Retain the last unambiguous photo for their transcript.
  for (const id of ambiguous) cache.delete(id);
  for (const [id, url] of avatars) {
    cache.delete(id);
    cache.set(id, url);
  }
  while (cache.size > 500) cache.delete(cache.keys().next().value!);
  return [...cache];
}
