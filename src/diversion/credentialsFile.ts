import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reads the CoreAPI access token `dv` already stores on disk.
 *
 * `dv login` and `dv authenticate <dvk_…>` both write
 * `~/.diversion/credentials/<userId>`, whose shape is:
 *
 *     { "token": { "access_token": "<JWT>", "token_type": "Bearer",
 *                  "refresh_token": "…", "expiry": "<ISO-8601>" },
 *       "info": { … }, "source": "…", "update_time": <unix seconds> }
 *
 * That `access_token` is the same kind of bearer the local agent mints via
 * `/token/core`, so reading it lets the CoreAPI keep working when the agent
 * isn't running — which is the whole point of an integration token on a
 * headless box. We never handle the `dvk_` value ourselves: `dv authenticate`
 * exchanges it and leaves the result here.
 *
 * Read-only, and the token is never logged, cached to disk, or sent anywhere
 * but the CoreAPI. The expiry check uses the file's own `expiry` field rather
 * than decoding the JWT — it's authoritative and cheaper.
 *
 * We deliberately do NOT refresh using `refresh_token`. The refresh flow is
 * unverified, and getting it wrong could rotate or invalidate the user's
 * credentials. An expired token here simply means "no token from this
 * source"; `dv login` re-mints one.
 */

/** Treat a token expiring within this window as already expired. */
const EXPIRY_SKEW_MS = 60_000;

export interface StoredToken {
  accessToken: string;
  /** Epoch ms, or undefined when the file carried no parseable expiry. */
  expiresAt?: number;
}

interface CredentialsFileShape {
  token?: {
    access_token?: string;
    token_type?: string;
    expiry?: string;
  };
}

export function credentialsDir(diversionHome?: string): string {
  return path.join(diversionHome ?? path.join(os.homedir(), '.diversion'), 'credentials');
}

/**
 * Load a still-valid access token from the on-disk credentials store.
 *
 * With `userId` we read that user's file directly. Without it we accept the
 * store only when it holds exactly one entry — guessing which of several
 * accounts to act as is not a decision to make silently.
 *
 * Returns undefined for every failure mode (missing, unreadable, malformed,
 * ambiguous, expired). Callers treat this as one source among several.
 */
export async function readStoredToken(
  opts: { diversionHome?: string; userId?: string; now?: number } = {},
): Promise<StoredToken | undefined> {
  const dir = credentialsDir(opts.diversionHome);
  const now = opts.now ?? Date.now();

  let file: string;
  if (opts.userId) {
    file = path.join(dir, opts.userId);
  } else {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return undefined; // no store at all
    }
    const candidates = entries.filter((e) => !e.startsWith('.'));
    if (candidates.length !== 1) return undefined;
    file = path.join(dir, candidates[0]!);
  }

  let parsed: CredentialsFileShape;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8')) as CredentialsFileShape;
  } catch {
    return undefined;
  }

  const accessToken = parsed.token?.access_token;
  if (!accessToken) return undefined;

  const rawExpiry = parsed.token?.expiry;
  if (rawExpiry) {
    const expiresAt = Date.parse(rawExpiry);
    if (!Number.isNaN(expiresAt)) {
      if (expiresAt - EXPIRY_SKEW_MS <= now) return undefined; // stale
      return { accessToken, expiresAt };
    }
  }
  // No usable expiry: hand the token over and let a 401 be the arbiter rather
  // than refusing something that may well be valid.
  return { accessToken };
}
