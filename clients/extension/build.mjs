import { context } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
          const stageRoot = resolve(__dirname, releaseDir, '.stage-unpacked');
          const folderName = 'meettina-extension';
          rmSync(zipPath, { force: true });
          rmSync(stageRoot, { recursive: true, force: true });
          cpSync(resolve(__dirname, outdir), resolve(stageRoot, folderName), { recursive: true });
          execFileSync('zip', ['-qrX', zipPath, folderName], { cwd: stageRoot });
          rmSync(stageRoot, { recursive: true, force: true });
          console.log(`Packed pinned unpacked archive (ID fcogeajjhhcadbnamadikkefdfmaaiil) → ${releaseDir}/${zipName}`);
        } else {
          const zipName = `meettina-extension-${manifest.version}.zip`;
          const zipPath = resolve(__dirname, releaseDir, zipName);
          rmSync(zipPath, { force: true });
          execFileSync('zip', ['-qrX', zipPath, '.'], { cwd: resolve(__dirname, outdir) });
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
