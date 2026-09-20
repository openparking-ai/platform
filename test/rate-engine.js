/**
 * The real rate engine, for the tests that need one.
 *
 * The plan store's whole claim is that a plan is validated by the ENGINE
 * before it is stored -- an unknown key refused and named, a gap refused and
 * listed -- and a stand-in that speaks the engine's shape would be this
 * platform's opinion of what the engine says, tested against itself. So the
 * suite starts the engine itself, the pinned version (`rate-engine.pin`,
 * installed by CI from that commit), on a loopback port, and points
 * RATE_ENGINE_URL at it. The read path needs no engine and the rest of the
 * suite never touches this.
 *
 * RATE_ENGINE_PYTHON names the interpreter that has `rate_engine` installed;
 * `python3` by default, which is what CI's install step leaves it in.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function startRateEngine({ timeoutMs = 15_000 } = {}) {
  const python = process.env.RATE_ENGINE_PYTHON || 'python3';
  const port = await freePort();
  const child = spawn(
    python,
    ['-c', `from rate_engine.service import serve; serve('127.0.0.1', ${port})`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let exited = null;
  child.once('exit', (code) => { exited = code; });
  for (;;) {
    if (exited !== null) {
      throw new Error(
        `rate engine exited with ${exited} before serving; is rate_engine installed for ` +
          `${python}? (RATE_ENGINE_PYTHON, see rate-engine.pin)\n${stderr}`,
      );
    }
    try {
      const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        const health = await res.json();
        return { url, health, stop: () => new Promise((r) => { child.once('exit', r); child.kill(); }) };
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`rate engine did not answer /v1/health within ${timeoutMs} ms\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
