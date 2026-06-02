/**
 * constants.ts
 *
 * Shared E2E media suite constants. Import from here rather than
 * duplicating port/URL values across config and setup files.
 */

// The native e2e server binds 8090, NOT 8080: the developer's dev `hush-api`
// container already owns 127.0.0.1:8080. Keeping the suite off 8080 lets it run
// alongside the dev stack without a port clash. Overridable for parallel runs.
export const SERVER_PORT = Number(process.env.HUSH_E2E_SERVER_PORT ?? 8090);
export const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;

export const PREVIEW_PORT = 4173;
export const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;

// Throwaway, fully isolated Postgres for the media suite. This is a DEDICATED
// ephemeral container (no named volume, --rm), NEVER the developer's dev
// `hush-postgres` container or its `postgres_data` volume. A suite run, and its
// teardown, can therefore never pollute or delete developer data. The database
// name is deliberately `hush_e2e`, distinct from the dev `hush` DB.
export const PG_CONTAINER = 'hush-e2e-postgres';
export const PG_HOST_PORT = 55432;
export const PG_USER = 'hush';
export const PG_PASSWORD = 'hush';
export const PG_DB = 'hush_e2e';
export const DATABASE_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${PG_DB}?sslmode=disable`;

// The suite reuses the already-running dev LiveKit on :7880. LiveKit is
// stateless (rooms are ephemeral, in-memory), so reuse pollutes no persistent
// data, and the dev container is already configured for local 127.0.0.1 ICE/RTC
// media, which is more reliable than remapping UDP on a throwaway. devkey /
// devsecret match the dev container config.
export const LIVEKIT_URL = 'ws://127.0.0.1:7880';
export const LIVEKIT_API_KEY = 'devkey';
export const LIVEKIT_API_SECRET = 'devsecret';
export const LIVEKIT_PORT = 7880;
