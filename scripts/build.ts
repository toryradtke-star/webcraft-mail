/**
 * Writes Vercel's Build Output API layout (.vercel/output): one bundled Node
 * function for every route, wm.js as a static file, and the daily cron.
 * Vercel runs this as the build command.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

const out = '.vercel/output';
rmSync(out, { recursive: true, force: true });
const fn = `${out}/functions/index.func`;
mkdirSync(fn, { recursive: true });
await build({ entryPoints: ['src/vercel.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm', outfile: `${fn}/index.mjs`,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
writeFileSync(`${fn}/.vc-config.json`, JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }));
mkdirSync(`${out}/static`, { recursive: true });
cpSync('public', `${out}/static`, { recursive: true });
writeFileSync(`${out}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: '/wm.js', headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' }, continue: true },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index' },
  ],
  // Hobby plans allow one cron run a day; signups send their first step inline, so only later steps wait for this.
  crons: [{ path: '/api/cron', schedule: '0 15 * * *' }],
}, null, 2));
console.log(`built ${out}`);
