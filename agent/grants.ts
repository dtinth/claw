/**
 * The local grants file: a map of `owner/repo` to the claw JWT minted for
 * that repo. This is the CLI's only credential store — it never sees the
 * server's private key or `CLAW_JWT_SECRET`.
 */

/** `owner/repo` -> claw JWT. */
export type GrantsStore = Record<string, string>;

/** Thrown when the grants file is missing, malformed, or lacks a grant. */
export class GrantsError extends Error {
  override name = "GrantsError";
}

/** Thrown specifically when the grants file doesn't exist yet (as opposed to being malformed). */
export class GrantsFileMissingError extends GrantsError {
  override name = "GrantsFileMissingError";
}

/**
 * Load and validate the grants file at `path`.
 *
 * @throws {GrantsFileMissingError} when the file doesn't exist.
 * @throws {GrantsError} when the file exists but isn't a `{"owner/repo": "<jwt>"}` map.
 */
export async function loadGrants(path: string): Promise<GrantsStore> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new GrantsFileMissingError(
        `no grants file at ${path} — create one with {"owner/repo": "<claw JWT>"}`,
      );
    }
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new GrantsError(`${path} is not valid JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new GrantsError(`${path} must be a JSON object mapping "owner/repo" to a claw JWT`);
  }

  const store: GrantsStore = {};
  for (const [repo, jwt] of Object.entries(data as Record<string, unknown>)) {
    if (typeof jwt !== "string" || jwt.trim() === "") {
      throw new GrantsError(`${path}: the grant for "${repo}" must be a non-empty string`);
    }
    store[repo] = jwt;
  }
  return store;
}

/**
 * Look up the grant for `repo`.
 *
 * @throws {GrantsError} when no grant is configured for that repo.
 */
export function findGrant(store: GrantsStore, repo: string): string {
  const jwt = store[repo];
  if (!jwt) {
    throw new GrantsError(
      `no grant for ${repo} — mint one in the claw web UI and add it to the grants file`,
    );
  }
  return jwt;
}

/** Result of {@link upsertGrant}. */
export interface UpsertGrantResult {
  /** Whether this replaced an existing grant for the same repo. */
  replaced: boolean;
}

/**
 * Add or update the grant for `repo` in the grants file at `path`, creating
 * the file and its directory if neither exists yet.
 *
 * @throws {GrantsError} when the file exists but is malformed — refuses to
 * overwrite it blind, so a corrupt file never loses its other grants silently.
 */
export async function upsertGrant(
  path: string,
  repo: string,
  jwt: string,
): Promise<UpsertGrantResult> {
  let store: GrantsStore;
  try {
    store = await loadGrants(path);
  } catch (error) {
    if (error instanceof GrantsFileMissingError) {
      store = {};
    } else {
      throw error;
    }
  }

  const replaced = Object.hasOwn(store, repo);
  store[repo] = jwt;

  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(store, null, 2) + "\n");
  try {
    // Best-effort: the file holds live credentials, keep it off-limits to others.
    await Deno.chmod(path, 0o600);
  } catch {
    // Unsupported on some platforms (e.g. Windows) — not fatal.
  }

  return { replaced };
}
