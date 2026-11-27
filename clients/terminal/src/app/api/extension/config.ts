/** Runtime Chrome Web Store switch for the MeetTINA Extension menu item & download endpoint.
 *  When `MEETTINA_EXTENSION_STORE_URL` is set to a valid `https:` URL, Terminal directs users to
 *  the Chrome Web Store instead of serving the bundled unpacked ZIP — zero image rebuild needed. */
export function extensionStoreUrl(
  raw: string | undefined = process.env.MEETTINA_EXTENSION_STORE_URL,
): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
