/** MeetTINA Chrome Extension download endpoint.
 *  - When `MEETTINA_EXTENSION_STORE_URL` is configured (valid `https:` URL), responds with `302`
 *    redirect to the Chrome Web Store so existing download links keep working without a rebuild.
 *  - Otherwise streams the pinned unpacked `meettina-extension.zip` archive generated at image
 *    build time (`public/downloads/meettina-extension.zip`) or from `../extension/release/` in dev. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { extensionStoreUrl } from "../config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ARCHIVE_FILENAME = "meettina-extension.zip";
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

async function readExtensionArchive(): Promise<Buffer | null> {
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, "public", "downloads", ARCHIVE_FILENAME),
    path.resolve(cwd, "..", "extension", "release", ARCHIVE_FILENAME),
  ];
  for (const candidate of candidates) {
    try {
      const data = await readFile(candidate);
      if (data.byteLength > 0) return data;
    } catch {
      /* Try next candidate */
    }
  }
  return null;
}

export async function GET() {
  const storeUrl = extensionStoreUrl();
  if (storeUrl) {
    return NextResponse.redirect(storeUrl, { status: 302, headers: NO_STORE });
  }

  const archive = await readExtensionArchive();
  if (!archive) {
    return NextResponse.json(
      { error: "MeetTINA Extension archive is not available in this build." },
      { status: 404, headers: NO_STORE },
    );
  }

  return new NextResponse(new Uint8Array(archive), {
    status: 200,
    headers: {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${ARCHIVE_FILENAME}"`,
      "Content-Length": String(archive.byteLength),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
