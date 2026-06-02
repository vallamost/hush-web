/**
 * global-setup.ts
 *
 * Brings up an ISOLATED local stack for the Playwright media E2E suite:
 *   1. Validates docker availability.
 *   2. Checks the e2e server port (8090) is free (fails loud on an orphan).
 *   3. Starts a DEDICATED throwaway postgres container (ephemeral, --rm, own
 *      port, db `hush_e2e`). It is NEVER the dev `hush-postgres` container or
 *      its volume, so a run cannot pollute or delete developer data.
 *   4. Verifies the dev LiveKit is reachable on :7880 (reused; stateless).
 *   5. Builds the Go server once with -tags e2e_test, then spawns it directly so
 *      serverProcess.pid is the real server PID. The server auto-migrates the
 *      throwaway db via golang-migrate on boot.
 *   6. Waits for /api/health to return {"status":"ok"}.
 *   7. Writes PID + server URL to e2e/media/.state/server.json for teardown.
 *
 * Isolation rule: this suite must never touch the dev postgres. Postgres is a
 * throwaway container; LiveKit is reused read-only (no persistent state). There
 * is no `docker compose up`/`down` against the dev stack anywhere in setup or
 * teardown.
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import {
  DATABASE_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  LIVEKIT_PORT,
  LIVEKIT_URL,
  PG_CONTAINER,
  PG_DB,
  PG_HOST_PORT,
  PG_PASSWORD,
  PG_USER,
  SERVER_PORT,
  SERVER_URL,
} from './constants.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// __dirname is not defined in ES module scope; derive it from import.meta.url.
const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const HUSH_WEB_DIR = resolve(_dirname, '../..');
const HUSH_SERVER_DIR = resolve(
  process.env.HUSH_SERVER_DIR ?? join(HUSH_WEB_DIR, '../hush-server'),
);

const STATE_DIR = join(HUSH_WEB_DIR, 'e2e/media/.state');
const STATE_FILE = join(STATE_DIR, 'server.json');
const SERVER_BINARY = join(STATE_DIR, 'hush-e2e');

// NODE_IP for livekit ICE candidates when running locally.
const NODE_IP = process.env.NODE_IP ?? '127.0.0.1';

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 500;
const LIVEKIT_HEALTH_TIMEOUT_MS = 15_000;
const POSTGRES_HEALTH_TIMEOUT_MS = 60_000;
const SERVER_START_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertDockerAvailable(): void {
  try {
    execSync('docker info --format "{{.ServerVersion}}"', {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } catch (err) {
    throw new Error(
      'Docker daemon is not available or not running. ' +
        'The E2E media suite requires Docker for the throwaway postgres and ' +
        `the dev livekit. Error: ${(err as Error).message}`,
    );
  }
}

/**
 * Proactively check that a host TCP port is free before we bind it. Fails loud
 * so the user knows to kill the orphan (the dev `hush-api` owns 8080, which is
 * why the e2e server uses 8090).
 */
async function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new Error(
          `Port ${port} is already in use. An orphan e2e server may be running. ` +
            `Kill it before running the suite (e.g. lsof -nP -iTCP:${port} -sTCP:LISTEN).`,
        ),
      );
    });
    socket.once('error', () => {
      // Connection refused: port is free.
      resolve();
    });
  });
}

/** TCP-level readiness check: opens a connection to host:port. */
function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * Starts the dedicated throwaway postgres container. Removes any orphan of the
 * same name first, then runs an ephemeral `--rm` container with no named volume
 * so nothing survives teardown. This never touches the dev `hush-postgres`.
 */
function startThrowawayPostgres(): void {
  // Remove a prior orphan (e.g. from a crashed run) so the run is deterministic.
  try {
    execSync(`docker rm -f ${PG_CONTAINER}`, { stdio: 'pipe', timeout: 15_000 });
  } catch {
    // No orphan to remove.
  }
  console.log(`[setup] starting throwaway postgres (${PG_CONTAINER}) on :${PG_HOST_PORT}...`);
  execSync(
    `docker run -d --rm --name ${PG_CONTAINER} ` +
      `-e POSTGRES_USER=${PG_USER} -e POSTGRES_PASSWORD=${PG_PASSWORD} -e POSTGRES_DB=${PG_DB} ` +
      `-p 127.0.0.1:${PG_HOST_PORT}:5432 postgres:16-alpine`,
    { stdio: 'pipe', timeout: 30_000 },
  );
}

async function waitForPostgresHealthy(): Promise<void> {
  const deadline = Date.now() + POSTGRES_HEALTH_TIMEOUT_MS;
  console.log('[setup] waiting for throwaway postgres to be ready...');
  while (Date.now() < deadline) {
    try {
      execSync(`docker exec ${PG_CONTAINER} pg_isready -U ${PG_USER} -d ${PG_DB}`, {
        stdio: 'pipe',
        timeout: 5_000,
      });
      console.log('[setup] throwaway postgres is ready');
      return;
    } catch {
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `throwaway postgres did not become ready within ${POSTGRES_HEALTH_TIMEOUT_MS}ms`,
  );
}

/**
 * Verifies the reused dev LiveKit is reachable on :7880. The suite does not
 * manage LiveKit's lifecycle; if it is down, fail loud with the exact command
 * to start it rather than silently producing zero-media results.
 */
async function waitForLiveKitReady(): Promise<void> {
  const deadline = Date.now() + LIVEKIT_HEALTH_TIMEOUT_MS;
  console.log(`[setup] checking dev livekit reachable on :${LIVEKIT_PORT}...`);
  while (Date.now() < deadline) {
    if (await isTcpPortOpen('127.0.0.1', LIVEKIT_PORT, 2_000)) {
      console.log('[setup] livekit is reachable');
      return;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `dev livekit is not reachable on :${LIVEKIT_PORT}. Start it with ` +
      `\`docker compose up -d livekit\` in hush-server, then rerun the suite.`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<void> {
  console.log('[setup] starting isolated E2E media stack...');

  assertDockerAvailable();

  if (!existsSync(HUSH_SERVER_DIR)) {
    throw new Error(
      `hush-server directory not found at ${HUSH_SERVER_DIR}. ` +
        'Set HUSH_SERVER_DIR env var to its absolute path.',
    );
  }

  await assertPortFree(SERVER_PORT);

  mkdirSync(STATE_DIR, { recursive: true });

  startThrowawayPostgres();
  await waitForPostgresHealthy();
  await waitForLiveKitReady();

  // Build the binary once so spawning it gives us the real server PID, not a
  // `go run` wrapper PID (which would make teardown's kill miss the server).
  console.log(`[setup] building server binary -> ${SERVER_BINARY} ...`);
  const buildResult = spawnSync(
    'go',
    ['build', '-tags', 'e2e_test', '-o', SERVER_BINARY, './cmd/hush'],
    {
      cwd: HUSH_SERVER_DIR,
      env: { ...process.env },
      stdio: 'pipe',
      timeout: 120_000,
    },
  );
  if (buildResult.status !== 0) {
    const stderr = buildResult.stderr?.toString() ?? '(no stderr)';
    throw new Error(`[setup] go build failed (exit ${buildResult.status}):\n${stderr}`);
  }
  console.log('[setup] server binary built');

  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-jwt-secret-local-only',
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    LIVEKIT_URL,
    // The browser connects to LiveKit directly (no reverse proxy in the e2e
    // stack), so the token endpoint must hand it the reachable dev LiveKit URL.
    // Without this the client falls back to <instance>/livekit and gets a 404.
    LIVEKIT_PUBLIC_URL: LIVEKIT_URL,
    NODE_IP,
    HOST: '127.0.0.1',
    PORT: String(SERVER_PORT),
    PRODUCTION: 'false',
    CORS_ORIGIN: '*',
    GIPHY_API_KEY: '',
    TRANSPARENCY_LOG_PRIVATE_KEY: '',
    ADMIN_BOOTSTRAP_SECRET: 'e2e-admin-secret',
    SERVICE_IDENTITY_MASTER_KEY: 'e2e-service-identity-key',
  };

  console.log('[setup] spawning server binary...');
  const serverProcess = spawn(SERVER_BINARY, [], {
    cwd: HUSH_SERVER_DIR,
    env: serverEnv,
    stdio: 'inherit',
    detached: false,
  });

  // Track early exit so the health-wait loop fails fast instead of polling to
  // timeout (which could silently succeed if another server answered).
  let serverExited = false;
  let serverExitInfo = '';
  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 || signal != null) {
      serverExited = true;
      serverExitInfo = `code=${code} signal=${signal}`;
    }
  });
  serverProcess.on('error', (err) => {
    serverExited = true;
    serverExitInfo = `spawn error: ${err.message}`;
    console.error('[setup] server process error:', err);
  });

  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { pid: serverProcess.pid, serverUrl: SERVER_URL, binaryPath: SERVER_BINARY },
      null,
      2,
    ),
    'utf8',
  );

  // Tests reach the server directly via this env var.
  process.env.HUSH_E2E_SERVER_URL = SERVER_URL;

  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  console.log(`[setup] waiting for server health at ${SERVER_URL}/api/health...`);
  while (Date.now() < deadline) {
    if (serverExited) {
      try { serverProcess.kill('SIGTERM'); } catch { /* best-effort */ }
      throw new Error(
        `[setup] server process exited prematurely (${serverExitInfo}). ` +
          'Check for EADDRINUSE or a misconfigured env var.',
      );
    }
    try {
      const resp = await fetch(`${SERVER_URL}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string };
        if (body.status === 'ok') {
          console.log('[setup] server is healthy');
          break;
        }
      }
    } catch {
      // keep polling
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  if (Date.now() >= deadline && !serverExited) {
    try { serverProcess.kill('SIGTERM'); } catch { /* best-effort */ }
    throw new Error(
      `server did not become healthy within ${SERVER_START_TIMEOUT_MS}ms at ${SERVER_URL}/api/health`,
    );
  }

  console.log('[setup] isolated stack is up. server =', SERVER_URL);
}
