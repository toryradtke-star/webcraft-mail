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
    // The owner app is static; its API is the function.
    { src: '/app/?', dest: '/app/index.html', headers: { 'cache-control': 'no-cache', 'x-frame-options': 'DENY' } },
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index' },
  ],
  // Hobby plans allow one cron run a day. The CRM needs more (waits, reminders, quiet-hour texts),
  // so .github/workflows/tick.yml calls /api/cron every 5 minutes; this daily run is the backstop.
  crons: [{ path: '/api/cron', schedule: '0 15 * * *' }],
}, null, 2));
console.log(`built ${out}`);
