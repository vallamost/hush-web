import { defineConfig } from '@playwright/test';
import { PREVIEW_PORT, PREVIEW_URL } from './e2e/media/constants.js';

export default defineConfig({
  testDir: './e2e/media',
  globalSetup: './e2e/media/global-setup.ts',
  globalTeardown: './e2e/media/global-teardown.ts',

  // Serial execution: the stack lifecycle is single-threaded and the
  // smoke suite exercises one shared server instance.
  workers: 1,
  fullyParallel: false,

  // Per-test timeout. Stack bring-up happens in globalSetup (not here).
  timeout: 60_000,

  use: {
    baseURL: PREVIEW_URL,

    // Fake media devices so the browser does not prompt for permissions in CI
    // and tests that join voice rooms get deterministic fake tracks.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },

  // Build hush-web with VITE_E2E_DIAG=1 and point the bundle at the local
  // native server. The app resolves its API base from window.location.origin
  // when it is not the canonical hosted instance, so serving preview at
  // localhost:4173 is sufficient for the app to target the local server at
  // 127.0.0.1:8080 via the proxy-less preview (both on the same host).
  //
  // VITE_E2E_DIAG is read by the diagnostics surface gated in Task 2/3.
  webServer: {
    command: [
      // Build: inline VITE_E2E_DIAG and override the API prefix so fetch
      // calls to /api/** reach the local Go server. The CORS_ORIGIN env var
      // on the server side is set to '*' in global-setup so cross-origin
      // requests from the preview origin pass.
      `VITE_E2E_DIAG=1 npm run build`,
      // Preview: pin port and refuse to reuse an existing server so a
      // stale process never masks a bring-up failure.
      `npm run preview -- --port ${PREVIEW_PORT} --strictPort`,
    ].join(' && '),

    url: PREVIEW_URL,
    reuseExistingServer: false,
    timeout: 120_000,

    // Pass through so Vite can resolve __dirname etc.
    env: {
      NODE_ENV: 'production',
      VITE_E2E_DIAG: '1',
    },
  },
});
