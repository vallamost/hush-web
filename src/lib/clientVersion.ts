// Single source for the running client's semantic version. Imported by the
// handshake-compatibility check that decides whether the server's advertised
// `min_client_version` requires an Update Required dialog.
//
// We read from package.json so a release bump in CI propagates without an
// extra source edit. Vite / Vitest both support JSON imports natively, so
// no special config is needed.

// `assert { type: 'json' }` keeps the import standards-conformant under both
// Vite (build) and Vitest (test) without needing a tsconfig change.
import pkg from "../../package.json" with { type: "json" };

/**
 * Semantic version string for the running client (e.g. "0.7.0-alpha.13").
 * Compared against handshake.min_client_version on every instance boot.
 */
export const CLIENT_VERSION: string = (pkg as { version: string }).version;

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
};

/**
 * Parse a semver-ish version string into a comparable shape. Build metadata is
 * ignored; prerelease identifiers are compared using SemVer precedence rules so
 * alpha bumps like 0.7.0-alpha.14 correctly outrank 0.7.0-alpha.13.
 */
function parseVersion(v: string): ParsedVersion | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : null,
  };
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      return Number(left) > Number(right) ? 1 : -1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Returns true iff `required` is strictly greater than `current`.
 *
 * @example isClientBelowMinimum("0.7.0-alpha.14", "0.7.0-alpha.13") === true
 * @example isClientBelowMinimum("0.7.0", "0.7.0-alpha.13") === true
 * @example isClientBelowMinimum("0.8.0", "0.7.0-alpha.13") === true
 */
export function isClientBelowMinimum(
  required: string | null | undefined,
  current: string = CLIENT_VERSION,
): boolean {
  if (!required) return false;
  const a = parseVersion(required);
  const b = parseVersion(current);
  if (!a || !b) return false;
  return compareVersions(a, b) > 0;
}

/**
 * Compare two semver-ish strings, tolerating a leading "v" prefix.
 *
 * Returns a negative number when `a` precedes `b`, a positive number when `a`
 * follows `b`, 0 when equal, and null when either string cannot be parsed.
 * Build metadata is ignored; prerelease precedence follows SemVer rules.
 */
export function compareSemverStrings(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  if (typeof a !== "string" || typeof b !== "string") return null;
  const pa = parseVersion(a.replace(/^v/, ""));
  const pb = parseVersion(b.replace(/^v/, ""));
  if (!pa || !pb) return null;
  return compareVersions(pa, pb);
}
