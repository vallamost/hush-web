import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';
import { PWA_OPTIONS } from './src/lib/pwaWorkboxOptions.js';
import fs from 'node:fs';

// Custom middleware to force correct MIME type for WASM files
const wasmContentTypePlugin = {
  name: 'wasm-content-type-plugin',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      // Check for .wasm in URL (may have query params like ?v=xxx)
      if (req.url && req.url.includes('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.includes('.wasm')) {
        res.setHeader('Content-Type', 'application/wasm');
      }
      next();
    });
  },
};

// HTTPS dev server gated behind VITE_HTTPS=true. Required when reaching the
// dev server from a LAN IP (mobile testing) because `crypto.subtle`,
// `navigator.clipboard`, and other secure-context APIs are unavailable on
// plain HTTP outside localhost. Default off so localhost dev stays
// cert-warning-free.
const httpsEnabled = process.env.VITE_HTTPS === 'true';

// When the developer has set up a local mkcert pair under .certs/ we use
// those files so LAN/mobile clients (with the mkcert root CA installed)
// see a fully trusted cert and stop hitting ERR_CERT_AUTHORITY_INVALID
// on every fetch. Falls back to the auto-generated self-signed cert
// from @vitejs/plugin-basic-ssl when the files are not present (so a
// fresh checkout still works without setup). Dev-only (the .certs/
// directory is gitignored.
const mkcertKeyPath = path.resolve(__dirname, '.certs/dev-key.pem');
const mkcertCertPath = path.resolve(__dirname, '.certs/dev-cert.pem');
const hasMkcertPair = httpsEnabled
  && fs.existsSync(mkcertKeyPath)
  && fs.existsSync(mkcertCertPath);
const httpsServerOption = hasMkcertPair
  ? {
      key: fs.readFileSync(mkcertKeyPath),
      cert: fs.readFileSync(mkcertCertPath),
    }
  : undefined;

export default defineConfig(({ mode }) => ({
  // Only these env prefixes are allowed to reach the client bundle. Local
  // debug flags such as VITE_ERUDA / VITE_DEBUG_TOOLBAR are consumed below as
  // build-time constants and must never appear in production assets.
  envPrefix: ['VITE_API_', 'VITE_LIVEKIT_'],
  define: {
    __HUSH_DEV_DEBUG__: JSON.stringify(mode !== 'production'),
    __HUSH_DEBUG_TOOLBAR__: JSON.stringify(
      mode !== 'production' && process.env.VITE_DEBUG_TOOLBAR === 'true',
    ),
    __HUSH_ERUDA__: JSON.stringify(
      mode !== 'production' && process.env.VITE_ERUDA === 'true',
    ),
    // E2E diagnostics flag. VITE_E2E_DIAG is not in envPrefix (it must never
    // appear in production assets), so it is injected as a define constant here
    // and rewritten into import.meta.env.VITE_E2E_DIAG at build time.
    'import.meta.env.VITE_E2E_DIAG': JSON.stringify(
      process.env.VITE_E2E_DIAG ?? '',
    ),
  },
  plugins: [
    wasmContentTypePlugin,
    wasm(),
    topLevelAwait(),
    tailwindcss(),
    react(),
    // basicSsl auto-generates a self-signed cert at runtime. Skip it
    // when an mkcert pair is on disk, Vite reads our cert/key from
    // server.https below instead.
    ...(httpsEnabled && !hasMkcertPair ? [basicSsl()] : []),
    // PWA / Service Worker. Conservative: precache app-shell only, never
    // touch /api, /ws, /livekit, or attachment routes. Update activation is
    // gated by the Update Required dialog (see src/lib/pwaUpdate.js).
    VitePWA(PWA_OPTIONS),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@gethush/hush-crypto'],
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
    port: 5173,
    allowedHosts: ['hushdev.duckdns.org'],
    https: httpsServerOption,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
    fs: {
      allow: ['..'],
    },
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': {
        target: 'http://localhost:8080',
        ws: true,
      },
      '/livekit': {
        target: 'http://localhost:7880',
        ws: true,
        rewrite: (path) => path.replace(/^\/livekit/, ''),
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-motion': ['motion'],
        },
      },
    },
  },
}));
