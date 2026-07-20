/**
 * The local CLI config file: currently just the claw server URL, so it
 * doesn't have to be re-exported as `CLAW_BASE_URL` every session. Separate
 * from `grants.json` (which holds credentials) — this file holds no secrets.
 */

export interface AgentConfig {
  baseUrl?: string;
}

/** Thrown when the config file is malformed. */
export class ConfigStoreError extends Error {
  override name = "ConfigStoreError";
}

/** Thrown specifically when the config file doesn't exist yet. */
export class ConfigFileMissingError extends ConfigStoreError {
  override name = "ConfigFileMissingError";
}

/**
 * Load and validate the config file at `path`.
 *
 * @throws {ConfigFileMissingError} when the file doesn't exist.
 * @throws {ConfigStoreError} when the file exists but is malformed.
 */
export async function loadConfig(path: string): Promise<AgentConfig> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ConfigFileMissingError(`no config file at ${path}`);
    }
    throw error;
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigStoreError(`${path} is not valid JSON`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new ConfigStoreError(`${path} must be a JSON object`);
  }

  const obj = data as Record<string, unknown>;
  const config: AgentConfig = {};
  if (obj.baseUrl !== undefined) {
    if (typeof obj.baseUrl !== "string" || obj.baseUrl.trim() === "") {
      throw new ConfigStoreError(`${path}: "baseUrl" must be a non-empty string`);
    }
    config.baseUrl = obj.baseUrl;
  }
  return config;
}

/**
 * Like {@link loadConfig}, but returns `{}` when the file simply doesn't
 * exist yet (a malformed *existing* file still throws — never silently
 * treated as empty).
 */
export async function loadConfigOrEmpty(path: string): Promise<AgentConfig> {
  try {
    return await loadConfig(path);
  } catch (error) {
    if (error instanceof ConfigFileMissingError) return {};
    throw error;
  }
}

/** Set the configured server URL, creating the file and its directory if needed. */
export async function setBaseUrl(path: string, baseUrl: string): Promise<void> {
  const current = await loadConfigOrEmpty(path);
  const next: AgentConfig = { ...current, baseUrl };

  const dir = path.slice(0, path.lastIndexOf("/"));
  if (dir) await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(next, null, 2) + "\n");
}
