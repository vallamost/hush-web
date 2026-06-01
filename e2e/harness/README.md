# Headless voice-MLS E2E harness (HUSHHQ-106)

`client.mjs` is one real-app-code voice client with no browser and no LiveKit.
It runs the actual `src/lib` modules (`mlsGroup`, `mlsStore`, `voiceMlsSession`,
`ws`, `instanceApi`) and the real `@gethush/hush-crypto` WASM. The only shims are
environmental, never on the protocol path:

- `jsdom` provides `window`/`document` (WS network listeners, the MLS storage
  bridge assignment).
- `fake-indexeddb` provides `indexedDB` (per-process MLS state).
- the native Node `WebSocket`, `crypto`, and `fetch` are used as-is.
- the WASM is initialised from local bytes via `initSync` because the web-target
  glue's no-arg loader fetches a relative URL Node cannot fetch. Byte source
  only: the module and its init path stay byte-identical to production.

## Why two processes

The `@gethush/hush-crypto` WASM module and `window.mlsStorageBridge` are
per-realm singletons. Two clients in one process would share MLS group state and
would not be genuinely distinct, masking exactly the convergence bugs this suite
exists to catch. Each client must be its own OS process.

## Driver

The orchestrator is the Go test
`hush-server/internal/e2e/voice_convergence_test.go` (`-tags e2e_test`). It boots
a real server (`server.BuildServer`) over `httptest`, seeds a server + voice
channel + memberships, spawns two of these clients, coordinates ordering, and
asserts the converged final state (epoch + frame-key hash + bidirectional
decrypt).

## Protocol

Line-delimited JSON. One command per stdin line, one event per stdout line.
`console.log`/`info`/`debug` are routed to stderr so stdout carries only events.

Voice commands: `start`, `create`, `join`, `await_epoch` (`{epoch}`), `remove`
(`{identity:"<userId>:<deviceId>"}`), `encrypt` (`{nonceHex, plaintext}`),
`decrypt` (`{nonceHex, b64}`), `exit`.

Text commands: `text_start`, `text_create`, `text_join`, `text_await_epoch`
(`{epoch}`), `send_text` (`{plaintext}`), `text_remove`
(`{identity:"<userId>:<deviceId>"}`).

Events: `setup_done`, `started`, `created`, `joined`, `epoch_reached`, `removed`,
`frame_key`, `ciphertext`, `decrypted`, `commit_error`; `text_started`,
`text_created`, `text_joined`, `text_epoch_reached`, `text_sent`,
`text_received`, `text_removed`, `text_commit_error`, `text_decrypt_error`;
`error`, `fatal`, `bye`.

## Coverage

`e2e:protocol` (voice) and `e2e:chat-delivery-headless` (text). They prove
protocol-level convergence/delivery through the real server, real WS, real MLS
groups, and real crypto. They do NOT prove React rendering / message-list UI /
notifications, real LiveKit/WebRTC media, or FrameCryptor `decryptFailures`.
That is the deferred Playwright media/UI milestone (`e2e:media-delivery`).

## Running

The driver executes the client through the project's local `vite-node` so the
real modules resolve with the app's Vite config (path aliases, extensionless
imports):

```
node_modules/.bin/vite-node e2e/harness/client.mjs -- \
  --role creator --base-url http://127.0.0.1:PORT --ws-url ws://127.0.0.1:PORT/ws --channel <uuid>
```

Server-free bootstrap check (no DB, no server needed):

```
node_modules/.bin/vite-node e2e/harness/client.mjs -- --selftest
```

To run the full two-client suite from `hush-server`:

```
TEST_DATABASE_URL=postgres://user:pass@host:port/db?sslmode=disable \
HUSH_WEB_DIR=/abs/path/to/hush-web \
go test -tags e2e_test ./internal/e2e/...
```

It skips when `TEST_DATABASE_URL` (or `DATABASE_URL`) or `HUSH_WEB_DIR` is unset,
and when `node_modules`/the harness are absent (run `npm ci` in `HUSH_WEB_DIR`
first).
