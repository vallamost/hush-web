/**
 * global-teardown.ts
 *
 * Shuts down the ISOLATED E2E media stack: kills the native Go server and
 * removes the throwaway postgres container.
 *
 * It never runs `docker compose down` against the dev stack and never touches
 * the dev `hush-postgres` container or its volume. The only container it removes
 * is the dedicated throwaway `hush-e2e-postgres`. The reused dev LiveKit is left
 * running. Every step is best-effort so a teardown failure cannot mask the
 * actual test results.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PG_CONTAINER } from './constants.js';

// __dirname is not defined in ES module scope; derive it from import.meta.url.
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const HUSH_WEB_DIR = resolve(_dirname, '../..');
const STATE_DIR = join(HUSH_WEB_DIR, 'e2e/media/.state');
const STATE_FILE = join(STATE_DIR, 'server.json');

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

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      // Signal 0 checks existence without sending a signal.
      process.kill(pid, 0);
    } catch {
      console.log(`[teardown] PID ${pid} exited after SIGTERM`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

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
  console.log('[teardown] stopping isolated E2E media stack...');

  // 1. Kill the native Go server process (state file holds the real binary PID).
  if (existsSync(STATE_FILE)) {
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ServerState;
      if (state.pid) {
        killWithGrace(state.pid);
      }
    } catch (err) {
      console.warn('[teardown] could not read state file:', (err as Error).message);
    }
  } else {
    console.warn('[teardown] state file not found, skipping server kill');
  }

  // 2. Remove ONLY the throwaway postgres container. Never the dev stack.
  try {
    execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: 'pipe', timeout: 15_000 });
    console.log(`[teardown] removed throwaway postgres (${PG_CONTAINER})`);
  } catch (err) {
    console.warn('[teardown] docker rm throwaway postgres failed:', (err as Error).message);
  }

  console.log('[teardown] done');
}
