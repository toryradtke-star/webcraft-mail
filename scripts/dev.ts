/**
 * Local server on PGlite with a fake mailer that prints instead of sending.
 *   npm run dev            → http://localhost:8787 (data in .dev-db)
 * Loads examples/*.json as sites, and serves test/demo.html at /demo to try the forms.
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { handle } from '../src/app.ts';
import { migrate, pgliteSql } from '../src/db.ts';
import { flowHashes, configProblems } from '../src/config.ts';
import type { Env } from '../src/runner.ts';
import { sendResponse, toRequest } from '../src/node.ts';

const port = Number(process.env.PORT ?? 8787);
const sql = await pgliteSql(process.env.DEV_DB ?? '.dev-db');
await migrate(sql);
for (const f of readdirSync('examples').filter((f) => f.endsWith('.json'))) {
  const c = JSON.parse(readFileSync(`examples/${f}`, 'utf8'));
  c.origins = [...new Set([...c.origins, `http://localhost:${port}`])];
  const problems = configProblems(c);
  if (problems.length) { console.error(`${f}:\n  - ${problems.join('\n  - ')}`); continue; }
  await sql(`INSERT INTO sites (id, config, hashes, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, hashes = EXCLUDED.hashes`,
    [c.id, JSON.stringify(c), JSON.stringify(flowHashes(c))]);
  console.log(`site ${c.id} loaded`);
}
const env: Env = {
  sql, secret: 'dev-secret', publicUrl: `http://localhost:${port}`, adminToken: 'dev-admin', cronSecret: 'dev-cron', now: () => new Date(),
  mailer: async (m) => { console.log(`\n[mail] to ${m.to}: ${m.subject}\n${m.text}`); return { id: `dev-${Date.now()}` }; },
};
createServer(async (req, res) => {
  if (req.url === '/wm.js') { res.setHeader('content-type', 'text/javascript'); return res.end(readFileSync('public/wm.js')); }
  if (req.url?.startsWith('/demo')) { res.setHeader('content-type', 'text/html'); return res.end(readFileSync('test/demo.html')); }
  await sendResponse(res, await handle(env, await toRequest(req, `http://localhost:${port}`)));
}).listen(port, () => console.log(`webcraft-mail dev on http://localhost:${port}/demo`));
