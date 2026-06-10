/**
 * Launches the Vite dev server with its /api, /ws, and /livekit proxies pointed
 * at a remote Hush instance (a VM or server running the full stack behind
 * Caddy) instead of a local backend.
 *
 * Usage:
 *   npm run dev:vm                          # default host 192.168.1.75, HTTP
 *   npm run dev:vm:https                     # same, dev server over HTTPS
 *   node scripts/dev-remote.js 10.0.0.5     # one-off host override
 *   HUSH_DEV_HOST=chat.example.com npm run dev:vm
 *   npm run dev:vm -- --https               # serve the dev server over HTTPS
 *   npm run dev:vm -- --host                # other flags pass through to vite
 *
 * It sets VITE_DEV_API_TARGET / VITE_DEV_LIVEKIT_TARGET, which vite.config.js
 * reads for its dev proxy. secure:false there accepts the self-signed cert an
 * IP-mode instance serves via Caddy.
 *
 * --https sets VITE_HTTPS=true so vite.config.js serves the dev server over
 * TLS. This is required to reach the dev server from a LAN IP (phone/another
 * box) because secure-context APIs (crypto.subtle, clipboard) are unavailable
 * on plain HTTP outside localhost. Over http://localhost it is unnecessary.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');

const DEFAULT_INSTANCE_HOST = '192.168.1.75';

/**
 * Resolves the target instance origin from (in priority order) the first
 * non-flag CLI argument, the HUSH_DEV_HOST env var, or the built-in default.
 * Bare hostnames are upgraded to https. Returns the origin plus the remaining
 * arguments to forward verbatim to vite.
 */
function resolveInstanceTarget() {
  const forwardedArgs = process.argv.slice(2);
  const hostArgIndex = forwardedArgs.findIndex((arg) => !arg.startsWith('-'));
  const requestedHost =
    hostArgIndex >= 0
      ? forwardedArgs.splice(hostArgIndex, 1)[0]
      : process.env.HUSH_DEV_HOST || DEFAULT_INSTANCE_HOST;
  const origin = /^https?:\/\//i.test(requestedHost)
    ? requestedHost
    : `https://${requestedHost}`;

  // --https is consumed here (Vite 5 has no such CLI flag) and translated into
  // VITE_HTTPS, which vite.config.js reads. Honor an externally-set VITE_HTTPS
  // too so `VITE_HTTPS=true npm run dev:vm` keeps working.
  const httpsFlagIndex = forwardedArgs.indexOf('--https');
  const devServerHttps =
    httpsFlagIndex >= 0 || process.env.VITE_HTTPS === 'true';
  if (httpsFlagIndex >= 0) {
    forwardedArgs.splice(httpsFlagIndex, 1);
  }

  return { origin, forwardedArgs, devServerHttps };
}

const { origin, forwardedArgs, devServerHttps } = resolveInstanceTarget();
const viteBinary = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite',
);

console.log(
  `[dev:vm] proxying /api, /ws, /livekit -> ${origin} ` +
    `(dev server: ${devServerHttps ? 'https' : 'http'})`,
);

const viteProcess = spawn(viteBinary, forwardedArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_DEV_API_TARGET: origin,
    VITE_DEV_LIVEKIT_TARGET: origin,
    VITE_HTTPS: devServerHttps ? 'true' : '',
  },
});

viteProcess.on('exit', (code) => process.exit(code ?? 0));
viteProcess.on('error', (spawnError) => {
  console.error(`[dev:vm] failed to start vite: ${spawnError.message}`);
  process.exit(1);
});
