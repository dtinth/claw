/**
 * Where the CLI keeps its own state: the grants file and the per-repo token
 * cache. Never shares a directory with the server (which has no state at all).
 */

/** The environment variables {@link resolvePaths} reads. */
export interface PathEnv {
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  XDG_CACHE_HOME?: string;
  CLAW_CONFIG_DIR?: string;
  CLAW_CACHE_DIR?: string;
}

export interface Paths {
  /** Directory holding `grants.json`. */
  configDir: string;
  /** Directory holding per-repo cached tokens. */
  cacheDir: string;
}

/** Thrown when neither an override nor `HOME` is available to derive a path. */
export class PathsError extends Error {
  override name = "PathsError";
}

/**
 * Resolve the config and cache directories, in priority order:
 * `CLAW_CONFIG_DIR`/`CLAW_CACHE_DIR`, then `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`,
 * then `$HOME/.config`/`$HOME/.cache`.
 *
 * @throws {PathsError} when a directory can't be derived from any of those.
 */
export function resolvePaths(env: PathEnv): Paths {
  const home = env.HOME?.trim();
  const configBase = env.XDG_CONFIG_HOME?.trim() || (home ? `${home}/.config` : "");
  const cacheBase = env.XDG_CACHE_HOME?.trim() || (home ? `${home}/.cache` : "");

  const configDir = env.CLAW_CONFIG_DIR?.trim() || (configBase ? `${configBase}/claw` : "");
  const cacheDir = env.CLAW_CACHE_DIR?.trim() || (cacheBase ? `${cacheBase}/claw` : "");

  if (!configDir || !cacheDir) {
    throw new PathsError(
      "could not determine where to store claw state: set HOME, or set " +
        "CLAW_CONFIG_DIR and CLAW_CACHE_DIR explicitly",
    );
  }
  return { configDir, cacheDir };
}
