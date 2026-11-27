import { context } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH = process.argv.includes('--watch');
const RELEASE = process.argv.includes('--release');
const UNPACKED = process.argv.includes('--unpacked');
const PACK = process.argv.includes('--pack');
const RELEASE_HOSTS = ['https://meettina.site/*', 'https://meet.google.com/*'];
// Public RSA SubjectPublicKeyInfo from Chrome Web Store for MeetTina (not a secret).
// Pins unpacked installs across all machines/folders to ID: fcogeajjhhcadbnamadikkefdfmaaiil.
const MEETTINA_STORE_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnwueIW7+M7brddpytxiCubcCmirwvsqfQyAOTVCHSGB3gvM1gCKOt4jh8dwc8t1At1Q0DTU7VkgMphzaA2lW7TT4SO1LiYMh31P1NZJzQi+p82Vl8J+AE8ctm6m3rRdIQYDBPHz0sEP/SCUMsyLhsA42UNTNWGM/pkcp03ehD8netXyAVUjF7okuCYICjxo8qDzV03IjjX9PN1m+K4ybs0hESQ5YbnMw1MasltdCNQOXdo4oAgq8K+hJv7u/ptYWr8/k22cR4lwfBKq7kFDElAg838uYUhguQOGYYJqgARuWMLjZVWOuCDN/Hzj/hfe8rdO68rj7aeEDySHqKdiX3wIDAQAB';
const outdir = 'dist';
const releaseDir = 'release';

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function collectFiles(rootDir, prefix = '') {
  const entries = [];
  for (const dirent of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = resolve(rootDir, dirent.name);
    const rel = prefix ? posix.join(prefix, dirent.name) : dirent.name;
    if (dirent.isDirectory()) entries.push(...collectFiles(abs, rel));
    else if (dirent.isFile()) entries.push({ abs, name: rel });
  }
  return entries;
}

/** Pure-Node ZIP archive writer so packing works identically on macOS, Linux, and slim Docker images without external `zip`. */
function writeZipArchive(zipPath, rootDir, rootPrefix = '') {
  const files = collectFiles(rootDir, rootPrefix);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const raw = readFileSync(file.abs);
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(raw);
    const nameBuf = Buffer.from(file.name, 'utf8');

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localChunks.push(local, payload);
    centralChunks.push(central);
    offset += local.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(zipPath, Buffer.concat([...localChunks, centralBuf, eocd]));
}

try {
  rmSync(outdir, { recursive: true, force: true });
} catch (error) {
  if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
}
mkdirSync(outdir, { recursive: true });

const postBuild = {
  name: 'post-build',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      cpSync('src/sidepanel.html', `${outdir}/sidepanel.html`);
      cpSync('src/meet-panel.html', `${outdir}/meet-panel.html`);
      cpSync('src/welcome.html', `${outdir}/welcome.html`);
      cpSync('src/welcome.css', `${outdir}/welcome.css`);
      cpSync('assets', `${outdir}/assets`, {
        recursive: true,
        filter: src => !/(?:^|[\\/])README\.md$/i.test(src),
      });
      cpSync(resolve(__dirname, '../../branding/tokens.css'), `${outdir}/assets/tina-tokens.css`);
      const now = new Date();
      const minuteOfDay = now.getHours() * 60 + now.getMinutes();
      const version = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.${minuteOfDay}`;
      const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
      manifest.version = version;
      manifest.version_name = `${RELEASE ? (UNPACKED ? 'unpacked' : 'release') : 'viewer'} ${now.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`;
      if (RELEASE) {
        if (manifest.description.length > 132) {
          throw new Error(`Chrome Web Store manifest description must be <= 132 chars (got ${manifest.description.length}).`);
        }
        manifest.host_permissions = manifest.host_permissions.filter(host => RELEASE_HOSTS.includes(host));
      }
      if (UNPACKED || !RELEASE) {
        manifest.key = (process.env.TINA_EXTENSION_PUBLIC_KEY || MEETTINA_STORE_PUBLIC_KEY).trim();
      } else {
        delete manifest.key;
      }
      writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
      const modeLabel = RELEASE ? (UNPACKED ? ', unpacked-pinned' : ', release') : ', dev-pinned';
      console.log(`Built MeetTina → ${outdir}/ (${manifest.version}${modeLabel}${WATCH ? ', watching…' : ''})`);
      if (PACK) {
        mkdirSync(releaseDir, { recursive: true });
        if (UNPACKED) {
          const zipName = `meettina-unpacked-${manifest.version}.zip`;
          const zipPath = resolve(__dirname, releaseDir, zipName);
          const latestPath = resolve(__dirname, releaseDir, 'meettina-extension.zip');
          rmSync(zipPath, { force: true });
          writeZipArchive(zipPath, resolve(__dirname, outdir), 'meettina-extension');
          cpSync(zipPath, latestPath);
          console.log(`Packed pinned unpacked archive (ID fcogeajjhhcadbnamadikkefdfmaaiil) → ${releaseDir}/${zipName}`);
        } else {
          const zipName = `meettina-extension-${manifest.version}.zip`;
          const zipPath = resolve(__dirname, releaseDir, zipName);
          rmSync(zipPath, { force: true });
          writeZipArchive(zipPath, resolve(__dirname, outdir));
          console.log(`Packed Chrome Web Store archive → ${releaseDir}/${zipName}`);
        }
      }
    });
  },
};

const ctx = await context({
  entryPoints: {
    sidepanel: 'src/viewer.ts', 'viewer-background': 'src/viewer-background.ts',
    'meet-content': 'src/meet-content.ts', 'meet-panel': 'src/meet-panel.ts',
    welcome: 'src/welcome.ts',
  },
  outdir, bundle: true, format: 'iife', target: 'es2020', logLevel: 'silent', plugins: [postBuild],
});
if (WATCH) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
