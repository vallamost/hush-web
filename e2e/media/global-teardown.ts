/**
 * global-teardown.ts
 *
 * Shuts down the local E2E stack: kills the native Go server and runs
 * docker compose down for postgres + livekit.
 *
 * Never throws: every cleanup step is best-effort so a teardown failure
 * does not mask the actual test results.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// __dirname is not defined in ES module scope; derive it from import.meta.url.
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const HUSH_WEB_DIR = resolve(_dirname, '../..');
const HUSH_SERVER_DIR = resolve(
  process.env.HUSH_SERVER_DIR ?? join(HUSH_WEB_DIR, '../hush-server'),
);
const STATE_DIR = join(HUSH_WEB_DIR, 'e2e/media/.state');
const STATE_FILE = join(STATE_DIR, 'server.json');
const COMPOSE_OVERRIDE_FILE = join(STATE_DIR, 'docker-compose.e2e.yml');

// Fix C: same credential defaults used by global-setup so docker compose down
// receives the env block the compose file references. Without this, compose
// emits "variable is not set" warnings and may fail to match the running stack.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret';
const NODE_IP = process.env.NODE_IP ?? '127.0.0.1';
const POSTGRES_USER = process.env.POSTGRES_USER ?? 'hush';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'hush';
const POSTGRES_DB = process.env.POSTGRES_DB ?? 'hush';

const composeEnv = {
  ...process.env,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  NODE_IP,
  POSTGRES_USER,
  POSTGRES_PASSWORD,
  POSTGRES_DB,
};

interface ServerState {
  pid: number;
  serverUrl: string;
  binaryPath?: string;
}

/** Send SIGTERM, wait up to graceMs, then SIGKILL if the process is still alive. */
function killWithGrace(pid: number, graceMs = 3_000): void {
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[teardown] sent SIGTERM to server PID ${pid}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      console.log(`[teardown] PID ${pid} already exited`);
      return;
    }
    console.warn(`[teardown] SIGTERM to PID ${pid} failed:`, (err as Error).message);
    return;
  }

  // Poll until the process is gone or grace period expires.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      // Signal 0 checks existence without sending a signal.
      process.kill(pid, 0);
    } catch {
      // ESRCH: process is gone.
      console.log(`[teardown] PID ${pid} exited after SIGTERM`);
      return;
    }
    // Busy-wait is acceptable here; teardown runs once per suite.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  // Grace period expired: escalate to SIGKILL.
  try {
    process.kill(pid, 'SIGKILL');
    console.log(`[teardown] sent SIGKILL to server PID ${pid} (did not exit within ${graceMs}ms)`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      console.warn(`[teardown] SIGKILL to PID ${pid} failed:`, (err as Error).message);
    }
  }
}

export default async function globalTeardown(): Promise<void> {
  console.log('[teardown] stopping E2E media stack...');

  // 1. Kill the native Go server process (Fix A: now the real binary PID).
  if (existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(raw) as ServerState;
      if (state.pid) {
        killWithGrace(state.pid);
      }
    } catch (err) {
      console.warn('[teardown] could not read state file:', (err as Error).message);
    }
  } else {
    console.warn('[teardown] state file not found, skipping server kill');
  }

  // 2. Bring down compose services.
  // Fix C: pass composeEnv so the compose file variable substitution succeeds.
  try {
    const overrideFlag = existsSync(COMPOSE_OVERRIDE_FILE)
      ? `-f ${COMPOSE_OVERRIDE_FILE}`
      : '';
    execSync(
      `docker compose -f docker-compose.yml ${overrideFlag} down --volumes`,
      {
        cwd: HUSH_SERVER_DIR,
        env: composeEnv,
        stdio: 'inherit',
        timeout: 60_000,
      },
    );
    console.log('[teardown] compose services stopped');
  } catch (err) {
    console.warn('[teardown] docker compose down failed:', (err as Error).message);
  }

  console.log('[teardown] done');
}
