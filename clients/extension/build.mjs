import { context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH = process.argv.includes('--watch');
const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const postBuild = {
  name: 'post-build',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      cpSync('src/sidepanel.html', `${outdir}/sidepanel.html`);
      cpSync('assets', `${outdir}/assets`, { recursive: true });
      cpSync(resolve(__dirname, '../../branding/tokens.css'), `${outdir}/assets/tina-tokens.css`);
      const now = new Date();
      const minuteOfDay = now.getHours() * 60 + now.getMinutes();
      const version = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}.${minuteOfDay}`;
      const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
      manifest.version = version;
      manifest.version_name = `viewer ${now.toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`;
      writeFileSync(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2));
      console.log(`Built TINA Transcript Viewer → dist/ (${manifest.version}${WATCH ? ', watching…' : ''})`);
    });
  },
};

const ctx = await context({
  entryPoints: { sidepanel: 'src/viewer.ts', 'viewer-background': 'src/viewer-background.ts' },
  outdir, bundle: true, format: 'iife', target: 'es2020', logLevel: 'silent', plugins: [postBuild],
});
if (WATCH) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
