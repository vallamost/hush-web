/**
 * global-setup.ts
 *
 * Brings up the full local stack for the Playwright media E2E suite:
 *   1. Validates docker availability.
 *   2. Checks port 8080 is free (fails loud if an orphan occupies it).
 *   3. Starts compose services: postgres + livekit (in the hush-server dir).
 *   4. Waits for postgres to be healthy and livekit to be reachable on :7880.
 *   5. Builds the Go server binary once with -tags e2e_test, then spawns it
 *      directly so serverProcess.pid is the real server PID (not a go-run
 *      wrapper). The server auto-migrates via golang-migrate on boot.
 *   6. Waits for /api/health to return {"status":"ok"}.
 *   7. Writes PID + server URL to e2e/media/.state/server.json for teardown.
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { SERVER_PORT, SERVER_URL } from './constants.js';

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

// ---------------------------------------------------------------------------
// Credentials / env
// ---------------------------------------------------------------------------

// LiveKit dev credentials matching .env.example defaults.
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret';

// NODE_IP for livekit: when running locally the ICE candidates use 127.0.0.1.
const NODE_IP = process.env.NODE_IP ?? '127.0.0.1';

// DB credentials matching compose defaults.
const POSTGRES_USER = process.env.POSTGRES_USER ?? 'hush';
const POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD ?? 'hush';
const POSTGRES_DB = process.env.POSTGRES_DB ?? 'hush';

// ---------------------------------------------------------------------------
// Ports / URLs
// ---------------------------------------------------------------------------

// The compose postgres does NOT expose 5432 to the host (comment in compose:
// "port 5432 not exposed to host - host postgres already uses it"). The server
// must reach it via the Docker network using the container name. When running
// the server natively on the host, we need to route through the Docker-exposed
// port. We publish postgres on a non-conflicting port for E2E use.
// NOTE: docker-compose.yml does NOT expose postgres on the host. To allow the
// natively-run Go server to reach postgres, we start postgres with a host port
// mapping override via --publish in a dedicated compose override approach, OR
// we use `docker exec` network. The cleanest approach: run compose with an
// override file that publishes postgres on port 55432.
const POSTGRES_HOST_PORT = 55432;
const DATABASE_URL = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT}/${POSTGRES_DB}?sslmode=disable`;

const LIVEKIT_PORT = 7880;

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

const HEALTH_POLL_INTERVAL_MS = 500;
const LIVEKIT_HEALTH_TIMEOUT_MS = 30_000;
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
        'The E2E media suite requires Docker to start postgres and livekit. ' +
        `Error: ${(err as Error).message}`,
    );
  }
}

/**
 * Proactively check that a host TCP port is free before we try to bind it.
 * Fails loud with a clear message so the user knows to kill the orphan.
 */
async function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      reject(
        new Error(
          `Port ${port} is already in use. An orphan process may be running. ` +
            `Kill it before running the E2E suite: fuser -k ${port}/tcp`,
        ),
      );
    });
    socket.once('error', () => {
      // Connection refused: port is free.
      resolve();
    });
  });
}

/**
 * TCP-level readiness check: tries to open a connection to host:port.
 * Returns true on success, false on failure.
 */
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

async function waitForPostgresHealthy(): Promise<void> {
  const deadline = Date.now() + POSTGRES_HEALTH_TIMEOUT_MS;
  console.log('[setup] waiting for postgres to be healthy...');
  while (Date.now() < deadline) {
    try {
      execSync(
        `docker exec hush-postgres pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`,
        { stdio: 'pipe', timeout: 5_000 },
      );
      console.log('[setup] postgres is healthy');
      return;
    } catch {
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `postgres did not become healthy within ${POSTGRES_HEALTH_TIMEOUT_MS}ms`,
  );
}

/**
 * Waits for LiveKit to accept a real TCP connection on port 7880.
 * The container status check is kept as a secondary guard, but the primary
 * signal is a successful TCP handshake (not curl || true, which always passes).
 */
async function waitForLiveKitReady(): Promise<void> {
  const deadline = Date.now() + LIVEKIT_HEALTH_TIMEOUT_MS;
  console.log('[setup] waiting for livekit to be reachable on :7880...');
  while (Date.now() < deadline) {
    const open = await isTcpPortOpen('127.0.0.1', LIVEKIT_PORT, 2_000);
    if (open) {
      // Secondary check: confirm the container has not entered a crash loop.
      try {
        const status = execSync(
          'docker inspect --format "{{.State.Status}}" hush-livekit',
          { stdio: 'pipe', timeout: 5_000 },
        )
          .toString()
          .trim();
        if (status === 'running') {
          console.log('[setup] livekit is reachable and container is running');
          return;
        }
      } catch {
        // Container inspect failed; fall through to retry.
      }
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `livekit did not become reachable on :${LIVEKIT_PORT} within ${LIVEKIT_HEALTH_TIMEOUT_MS}ms`,
  );
}

async function waitForServerHealthy(serverUrl: string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  console.log(`[setup] waiting for server health at ${serverUrl}/api/health...`);
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${serverUrl}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { status?: string };
        if (body.status === 'ok') {
          console.log('[setup] server is healthy');
          return;
        }
      }
    } catch {
      // keep polling
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(
    `server did not become healthy within ${SERVER_START_TIMEOUT_MS}ms at ${serverUrl}/api/health`,
  );
}

// ---------------------------------------------------------------------------
// Compose override: publish postgres on a host port for the native server
// ---------------------------------------------------------------------------

const COMPOSE_OVERRIDE_FILE = join(STATE_DIR, 'docker-compose.e2e.yml');

function writeComposeOverride(): void {
  // Publishes postgres on 127.0.0.1:55432 so the natively-run Go server can
  // reach it. The main docker-compose.yml intentionally omits host-port
  // exposure because the developer's host postgres already occupies 5432.
  const content = `services:
  postgres:
    ports:
      - "127.0.0.1:${POSTGRES_HOST_PORT}:5432"
`;
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(COMPOSE_OVERRIDE_FILE, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<void> {
  console.log('[setup] starting E2E media stack...');

  assertDockerAvailable();

  if (!existsSync(HUSH_SERVER_DIR)) {
    throw new Error(
      `hush-server directory not found at ${HUSH_SERVER_DIR}. ` +
        'Set HUSH_SERVER_DIR env var to its absolute path.',
    );
  }

  // Fix B: check port is free before we proceed. Fail loud if occupied.
  await assertPortFree(SERVER_PORT);

  mkdirSync(STATE_DIR, { recursive: true });
  writeComposeOverride();

  // Compose environment: pass LiveKit creds + postgres creds so the compose
  // template substitution works even when no .env exists in hush-server.
  const composeEnv = {
    ...process.env,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    NODE_IP,
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
  };

  // Start postgres and livekit only (not hush-api, which we run natively).
  console.log('[setup] starting compose services: postgres, livekit...');
  execSync(
    `docker compose -f docker-compose.yml -f ${COMPOSE_OVERRIDE_FILE} up -d postgres livekit`,
    {
      cwd: HUSH_SERVER_DIR,
      env: composeEnv,
      stdio: 'inherit',
      timeout: 60_000,
    },
  );

  await waitForPostgresHealthy();
  await waitForLiveKitReady();

  // Fix A: build the binary once so spawning it gives us the real server PID,
  // not a go-run wrapper PID. `go run` spawns a linker/runner wrapper whose PID
  // is NOT the actual server binary, so teardown's kill would target the wrong
  // process and the real server would survive as an orphan.
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
    throw new Error(
      `[setup] go build failed (exit ${buildResult.status}):\n${stderr}`,
    );
  }
  console.log('[setup] server binary built');

  // Server environment: same as before, threaded through from the constants above.
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-jwt-secret-local-only',
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    HOST: '127.0.0.1',
    PORT: String(SERVER_PORT),
    PRODUCTION: 'false',
    // Wide CORS for the preview build origin and localhost.
    CORS_ORIGIN: '*',
    // Suppress optional features that are not needed for smoke.
    GIPHY_API_KEY: '',
    TRANSPARENCY_LOG_PRIVATE_KEY: '',
    ADMIN_BOOTSTRAP_SECRET: 'e2e-admin-secret',
    SERVICE_IDENTITY_MASTER_KEY: 'e2e-service-identity-key',
  };

  // Fix A: spawn the compiled binary directly. serverProcess.pid is now the
  // real server PID and teardown can kill it reliably.
  console.log('[setup] spawning server binary...');
  const serverProcess = spawn(SERVER_BINARY, [], {
    cwd: HUSH_SERVER_DIR,
    env: serverEnv,
    stdio: 'inherit',
    detached: false,
  });

  // Fix B: track early exit so the health-wait loop can fail fast instead
  // of polling until timeout (which would silently succeed if another server
  // on :8080 responds).
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

  // Persist state for teardown. PID is now the real binary PID.
  writeFileSync(
    STATE_FILE,
    JSON.stringify(
      { pid: serverProcess.pid, serverUrl: SERVER_URL, binaryPath: SERVER_BINARY },
      null,
      2,
    ),
    'utf8',
  );

  // Set env var so tests can reach the server directly.
  process.env.HUSH_E2E_SERVER_URL = SERVER_URL;

  // Health wait with early-exit guard (Fix B).
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  console.log(`[setup] waiting for server health at ${SERVER_URL}/api/health...`);
  while (Date.now() < deadline) {
    if (serverExited) {
      // Kill best-effort before throwing.
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

  console.log('[setup] stack is up. server =', SERVER_URL);
}
