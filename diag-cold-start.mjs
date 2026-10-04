// DIAGNOSTIC ONLY -- never merged. Measures the cold-start sign-in gap on a
// real runner, per phase, across variants of the product, interleaved so every
// variant sees the same load.
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname);
const ROUNDS = Number(process.env.ROUNDS || 25);
const ADMIN_ORIGIN = 'https://admin.example.test';

function patch(dir, file, from, to) {
  const p = join(dir, file);
  const s = readFileSync(p, 'utf8');
  if (s.split(from).length !== 2) throw new Error(`anchor not once in ${file}: ${from.slice(0, 60)}`);
  writeFileSync(p, s.replace(from, () => to));
}

function stage(variant) {
  const dir = mkdtempSync(join(tmpdir(), `diag-${variant}-`));
  for (const e of ['src', 'migrations', 'package.json']) cpSync(join(ROOT, e), join(dir, e), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  // Phase marks, every variant.
  patch(dir, 'src/signIn.js', "      const user = found ?? NOBODY;\n", "      const user = found ?? NOBODY; req.m = { found: performance.now() };\n");
  patch(dir, 'src/signIn.js', "      const locked = Boolean(", "      req.m.lock = performance.now(); const locked = Boolean(");
  patch(dir, 'src/signIn.js', "      // The place is for the hash, not for the floor: given back the moment it is done.\n", "      req.m.verify = performance.now();\n");
  patch(dir, 'src/signIn.js', "        await internals.recordFailure(user, address, Boolean(found) && !matches);\n",
    variant === 'nowrite'
      ? "        await internals.recordFailure(user, address, false); req.m.write = performance.now();\n"
      : "        await internals.recordFailure(user, address, Boolean(found) && !matches); req.m.write = performance.now();\n");
  patch(dir, 'src/signIn.js', "    if (wait > 0) await sleep(wait);\n",
    "    if (req.m) { const a = req.arrivedAt; console.error('[diag] ' + JSON.stringify({ found: req.m.found - a, lock: req.m.lock - req.m.found, verify: req.m.verify - req.m.lock, write: req.m.write - req.m.verify, work: performance.now() - a })); }\n    if (wait > 0) await sleep(wait);\n");
  return dir;
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function firstSignIn(dir, variant, email, address) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ADMIN_ORIGIN, TRUST_PROXY: 'loopback', SIGN_IN_REFUSAL_FLOOR_MS: '200' };
  if (variant === 'asynccommit') env.PGOPTIONS = '-c synchronous_commit=off';
  const child = spawn(process.execPath, ['src/server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', r));
  let err = '';
  try {
    await new Promise((res, rej) => {
      let out = '';
      const t = setTimeout(() => rej(new Error('not listening')), 30_000);
      child.stdout.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(t); res(); } });
      child.stderr.on('data', (d) => (err += d));
      child.once('exit', (c) => { clearTimeout(t); rej(new Error(`exited ${c} ${err}`)); });
    });
    const t0 = performance.now();
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ADMIN_ORIGIN, 'x-forwarded-for': address },
      body: JSON.stringify({ email, password: 'incorrect horse battery staple' }),
    });
    await r.text();
    const ms = performance.now() - t0;
    if (r.status !== 401) throw new Error(`status ${r.status}`);
    await new Promise((res) => setTimeout(res, 50));
    const m = /\[diag\] (\{.*\})/.exec(err);
    return { ms, ...(m ? JSON.parse(m[1]) : {}) };
  } finally {
    child.kill('SIGKILL'); await exited;
  }
}

const { pool, withTenant } = await import(join(ROOT, 'src/db.js'));
const { createAdmin } = await import(join(ROOT, 'src/adminAccount.js'));
const { randomUUID } = await import('node:crypto');
const tenant = randomUUID();
await withTenant(tenant, (c) => c.query('INSERT INTO tenants (id, slug, name) VALUES ($1,$2,$3)', [tenant, `diag-${tenant.slice(0, 8)}`, 'diag']));
const known = `diag-${tenant.slice(0, 8)}@example.com`;
await createAdmin({ tenantId: tenant, email: known, password: 'correct horse battery staple' });

const VARIANTS = (process.env.VARIANTS || 'base,nowrite,asynccommit').split(',');
const dirs = Object.fromEntries(VARIANTS.map((v) => [v, stage(v)]));
const rows = [];
let n = 0;
for (let i = 0; i < ROUNDS; i += 1) {
  for (const v of VARIANTS) {
    for (const kind of (i % 2 ? ['unknown', 'known'] : ['known', 'unknown'])) {
      n += 1;
      const addr = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
      const email = kind === 'known' ? known : `nobody-${tenant.slice(0, 8)}-${n}@example.com`;
      rows.push({ v, kind, ...(await firstSignIn(dirs[v], v, email, addr)) });
    }
  }
}
await pool.end();

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const label = process.env.LABEL || '';
console.log(`\n=== ${label} rounds=${ROUNDS} ===`);
console.log('variant      kind     n   min   p25   med   (phase medians: found lock verify write work)');
for (const v of VARIANTS) {
  const mins = {};
  for (const kind of ['known', 'unknown']) {
    const r = rows.filter((x) => x.v === v && x.kind === kind);
    const ms = r.map((x) => x.ms); mins[kind] = Math.min(...ms);
    const ph = ['found', 'lock', 'verify', 'write', 'work'].map((k) => q(r.map((x) => x[k] ?? NaN), 0.5).toFixed(1)).join(' ');
    console.log(`${v.padEnd(12)} ${kind.padEnd(8)} ${String(r.length).padStart(2)} ${Math.min(...ms).toFixed(0).padStart(5)} ${q(ms, 0.25).toFixed(0).padStart(5)} ${q(ms, 0.5).toFixed(0).padStart(5)}   ${ph}`);
  }
  console.log(`${v.padEnd(12)} GAP (fastest unknown - fastest known) = ${(mins.unknown - mins.known).toFixed(1)} ms`);
}
writeFileSync(`diag-${label || 'run'}.json`, JSON.stringify(rows));
