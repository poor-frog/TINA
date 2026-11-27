import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extensionStoreUrl } from "../extension/config";
import { GET } from "../extension/download/route";

describe("extensionStoreUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts only valid https Chrome Web Store URLs", () => {
    expect(extensionStoreUrl(undefined)).toBeNull();
    expect(extensionStoreUrl("")).toBeNull();
    expect(extensionStoreUrl("   ")).toBeNull();
    expect(extensionStoreUrl("http://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil")).toBeNull();
    expect(extensionStoreUrl("javascript:alert(1)")).toBeNull();
    expect(extensionStoreUrl("not a url")).toBeNull();
    expect(
      extensionStoreUrl("  https://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil  "),
    ).toBe("https://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil");
  });
});

describe("GET /api/extension/download", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redirects 302 to MEETTINA_EXTENSION_STORE_URL when configured", async () => {
    const store = "https://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil";
    vi.stubEnv("MEETTINA_EXTENSION_STORE_URL", store);

    const res = await GET();
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(store);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("serves public/downloads/meettina-extension.zip when bundled in the image", async () => {
    vi.stubEnv("MEETTINA_EXTENSION_STORE_URL", "");
    const root = mkdtempSync(path.join(os.tmpdir(), "tina-ext-dl-"));
    tempDirs.push(root);
    const downloadsDir = path.join(root, "public", "downloads");
    mkdirSync(downloadsDir, { recursive: true });
    const fakeZip = Buffer.from("PK\x03\x04fake-zip-payload");
    writeFileSync(path.join(downloadsDir, "meettina-extension.zip"), fakeZip);
    vi.spyOn(process, "cwd").mockReturnValue(root);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="meettina-extension.zip"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(fakeZip);
  });

  it("falls back to ../extension/release/meettina-extension.zip in local dev", async () => {
    vi.stubEnv("MEETTINA_EXTENSION_STORE_URL", "");
    const root = mkdtempSync(path.join(os.tmpdir(), "tina-ext-dev-"));
    tempDirs.push(root);
    const terminalDir = path.join(root, "terminal");
    const releaseDir = path.join(root, "extension", "release");
    mkdirSync(terminalDir, { recursive: true });
    mkdirSync(releaseDir, { recursive: true });
    const fakeZip = Buffer.from("PK\x03\x04dev-zip-payload");
    writeFileSync(path.join(releaseDir, "meettina-extension.zip"), fakeZip);
    vi.spyOn(process, "cwd").mockReturnValue(terminalDir);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(fakeZip);
  });

  it("returns 404 JSON when the archive is absent", async () => {
    vi.stubEnv("MEETTINA_EXTENSION_STORE_URL", "");
    const root = mkdtempSync(path.join(os.tmpdir(), "tina-ext-missing-"));
    tempDirs.push(root);
    vi.spyOn(process, "cwd").mockReturnValue(root);

    const res = await GET();
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("MeetTINA Extension");
  });
});
