![License](https://img.shields.io/badge/license-AGPL--3.0-blue)
![Node](https://img.shields.io/badge/node-22+-339933)
![React](https://img.shields.io/badge/react-18-61DAFB)

# hush-web

React web client for [Hush](https://gethush.live) - an end-to-end encrypted communication platform. The client runs OpenMLS compiled to WASM (`@gethush/hush-crypto`) directly in the browser. All encryption happens here, before any data reaches the server.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later

The `@gethush/hush-crypto` WASM package is published on [npmjs.com](https://www.npmjs.com/package/@gethush/hush-crypto). No extra authentication is needed.

---

## Setup

**1. Clone and install:**

```bash
git clone https://github.com/vallamost/hush-web
cd hush-web
npm ci
```

**3. Configure environment variables:**

```bash
cp .env.example .env.local
# Edit .env.local
```

See [Environment Variables](#environment-variables) below for required vars.

---

## Development

```bash
npm run dev
```

Starts Vite on `http://localhost:5173`. Vite proxies `/api`, `/ws`, and `/livekit` to the Go API (expected at `http://localhost:8080` by default, behind Caddy).

You need a running `hush-server` instance for the client to function. See the [hush-server](https://github.com/hushhq/hush-server) repository.

### Rebuilding the WASM crate

The WASM binary is shipped as part of the `@gethush/hush-crypto` npm package. You do not need to rebuild it for normal development. If you are working on `hush-crypto` locally:

```bash
# Force rebuild from local source
npm run build:wasm:force
```

---

## Testing

```bash
# Run all tests (Vitest, single run)
npm run test:run

# Run in watch mode
npm run test

# Run a specific test file
npx vitest run src/lib/mlsGroup
```

Tests cover MLS group operations, the vault (PIN-based key storage), authentication flows, and WebSocket reconnect behavior. All tests run in Vitest with a simulated WASM environment.

---

## Building for Production

```bash
npm run build
```

Output is in `dist/`. The build includes the WASM binary bundled via Vite's WASM plugin. Serve `dist/` as a static site behind the Go API / Caddy reverse proxy.

To build the Docker image:

```bash
docker build -t hush-web .
```

### Admin UI

`/admin` is **not** part of the hush-web client. The admin dashboard is embedded in `hush-server` and is served by the Go binary at `/admin/`. Do not include admin assets in a hush-web deploy.

---

## Hosted Deploy

`scripts/deploy.sh` publishes the built client using a timestamped release directory and an atomic symlink swap:

```bash
./scripts/deploy.sh --target /path/to/document-root
./scripts/deploy.sh --target /path/to/document-root --keep 10   # retain 10 releases
./scripts/deploy.sh --target /path/to/document-root --no-build  # skip build step
```

After a successful deploy the document root contains:

```
releases/
  20260413220000-abc1234/   <- this release
  20260412190000-def5678/   <- previous release
current -> releases/20260413220000-abc1234/   <- symlink; serve from here
```

Configure the web server to serve from `<target>/current`.

**Branch and revision discipline:** deploy only from a stable, intentional revision — a tagged release or a designated stable branch. Verify before deploying:

```bash
git log --oneline -1
git status
```

---

## Environment Variables

Variables prefixed with `VITE_` are embedded in the client bundle at build time.

| Variable | Required | Description |
|-|-|-|
| `VITE_API_BASE_URL` | Self-host only | Go API base URL (e.g., `https://chat.example.com`) |
| `VITE_WS_URL` | Self-host only | WebSocket URL (e.g., `wss://chat.example.com/ws`) |
| `VITE_LIVEKIT_URL` | Legacy/manual override only | LiveKit WebSocket URL (e.g., `wss://rtc.example.com/`) |
| `VITE_INSTANCE_NAME` | No | Display name shown in the client title |

**Hosted topology:** when the SPA is served from the same origin as the API (via a reverse proxy such as `hush-server/caddy/Caddyfile.prod`), no `VITE_*` variables are needed. Vite builds with relative-path defaults (`/api`, `/ws`, `/livekit`) that route correctly through the proxy.

**Self-hosted instances** where the SPA lives on a different domain than the API must set `VITE_API_BASE_URL` and `VITE_WS_URL`. Modern `hush-server` instances return their per-instance LiveKit signaling URL from `/api/livekit/token`; use `VITE_LIVEKIT_URL` only for legacy/manual deployments that cannot return that value.

**Never put private keys, bootstrap secrets, session secrets, or any other server-side secrets in `.env.local`** — Vite embeds these values in the JavaScript bundle.

---

## Project Structure

```
hush-web/
├── src/
│   ├── App.jsx              # Router (guild/channel layout)
│   ├── hooks/               # useAuth, useMLS, useRoom, useKeyPackageMaintenance
│   ├── lib/                 # API client, BIP39 identity, MLS group ops, vault, WebSocket client
│   ├── pages/               # TextChannel, VoiceChannel, ServerLayout, Home
│   └── components/          # Chat, ChannelList, MemberList, ServerList, Controls
├── public/                  # Static assets
├── vite.config.js           # Vite config (WASM plugin, API proxy)
└── vitest.config.js         # Vitest config
```

---

## Browser Support

| Browser | Chat E2EE | Media E2EE |
|-|-|-|
| Chromium (Chrome, Edge, Brave, Arc) | Full | Full |
| Firefox | Full | Partial |
| Safari | Full | Limited |

Full media E2EE requires Insertable Streams. See [SECURITY.md](https://github.com/hushhq/hush-server/blob/main/SECURITY.md) for details.

**WebCrypto is required.** The app will not load in environments where `window.crypto.subtle` is unavailable (non-HTTPS origins, some enterprise configurations). There is no fallback to unencrypted operation.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

[AGPL-3.0](LICENSE). If you modify and deploy this client, you must publish your changes under the same license.
