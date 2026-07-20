/**
 * The per-repo token cache. Installation tokens last ~1h; caching avoids
 * re-minting (and re-logging) on every single `claw token`/`claw exec` call.
 */

export interface CachedToken {
  token: string;
  /** ISO-8601 expiry, as returned by GitHub. */
  expiresAt: string;
}

/** Don't hand out a cached token with less than this much life left. */
const FRESHNESS_MARGIN_MS = 5 * 60 * 1000;

export function cachePath(cacheDir: string, repo: string): string {
  return `${cacheDir}/${repo.replace("/", "__")}.json`;
}

/** Read the cached token for `repo`, or `null` if there is none (or it's unreadable). */
export async function readCache(cacheDir: string, repo: string): Promise<CachedToken | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(cachePath(cacheDir, repo));
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(text) as Partial<CachedToken>;
    if (typeof data.token !== "string" || typeof data.expiresAt !== "string") return null;
    return { token: data.token, expiresAt: data.expiresAt };
  } catch {
    return null;
  }
}

/** Write the cached token for `repo`, creating `cacheDir` if needed. */
export async function writeCache(
  cacheDir: string,
  repo: string,
  entry: CachedToken,
): Promise<void> {
  await Deno.mkdir(cacheDir, { recursive: true });
  const path = cachePath(cacheDir, repo);
  await Deno.writeTextFile(path, JSON.stringify(entry));
  try {
    // Best-effort: the token is a live credential, keep it off-limits to others.
    await Deno.chmod(path, 0o600);
  } catch {
    // Unsupported on some platforms (e.g. Windows) — not fatal.
  }
}

/**
 * Remove the cached token for `repo`, if any. Used when the underlying grant
 * changes (`claw grant`) — a still-unexpired cached token would otherwise
 * keep being served for up to an hour after the grant it was minted under
 * was replaced.
 */
export async function clearCache(cacheDir: string, repo: string): Promise<void> {
  try {
    await Deno.remove(cachePath(cacheDir, repo));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Whether `entry` has more than the safety margin left before it expires. */
export function isFresh(entry: CachedToken, now: Date): boolean {
  const expires = Date.parse(entry.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires - now.getTime() > FRESHNESS_MARGIN_MS;
}
