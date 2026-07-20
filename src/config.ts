/**
 * Loading and validating claw's configuration from environment variables.
 *
 * All secrets are supplied by the deployment platform as env vars. Loading
 * aggregates every problem into a single {@link ConfigError} so a
 * misconfiguration surfaces all at once at start-up rather than one at a time.
 */

/** claw's validated runtime configuration. */
export interface Config {
  /** The GitHub App's numeric id (`GITHUB_APP_ID`). */
  appId: string;
  /** The GitHub App's private key in PEM form. */
  privateKeyPem: string;
  /** The GitHub App's OAuth client id (`GITHUB_CLIENT_ID`). */
  clientId: string;
  /** The GitHub App's OAuth client secret (`GITHUB_CLIENT_SECRET`). */
  clientSecret: string;
  /**
   * OAuth scopes requested at login (`GITHUB_OAUTH_SCOPES`), space-separated.
   * Defaults to `public_repo` so an OAuth App login can comment on any public
   * repo. Ignored by GitHub App logins (they derive access from permissions);
   * set to empty to omit the scope entirely.
   */
  oauthScopes: string;
  /** Secret used to sign intermediary claw JWTs (`CLAW_JWT_SECRET`). */
  jwtSecret: string;
  /** Public base URL, without trailing slash (`BASE_URL`). */
  baseUrl: string;
  /** The single GitHub login permitted to use claw (`ALLOWED_LOGIN`). */
  allowedLogin: string;
  /** TCP port to listen on (`PORT`). */
  port: number;
  /** Optional GitHub webhook secret (`GITHUB_WEBHOOK_SECRET`) for /webhook. */
  webhookSecret: string | undefined;
  /** Optional Grist connection for comment relay; undefined disables it. */
  grist: GristConfig | undefined;
}

/** Grist connection details for the comment-relay feature. */
export interface GristConfig {
  /** Base API URL including the document id (`GRIST_API_URL`). */
  apiUrl: string;
  /** Grist API key, sent as a bearer token (`GRIST_API_KEY`). */
  apiKey: string;
  /** Table name (`GRIST_TABLE_ID`), defaults to `Comments`. */
  table: string;
}

/** Thrown when configuration is missing or malformed. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Environment shape: a map of variable names to optional string values. */
export type Env = Record<string, string | undefined>;

/**
 * Normalize a private key supplied via an environment variable. Env vars can't
 * hold real newlines conveniently, so keys are commonly stored either with
 * escaped `\n` sequences or base64-encoded. This restores a usable PEM.
 */
export function normalizePrivateKey(raw: string): string {
  const value = raw.trim();
  if (value.includes("BEGIN")) {
    // A PEM pasted directly, possibly with escaped newlines.
    return value.replace(/\\n/g, "\n");
  }
  // Assume base64-encoded PEM.
  try {
    return atob(value);
  } catch {
    throw new ConfigError("GITHUB_APP_PRIVATE_KEY is neither a PEM nor valid base64");
  }
}

function required(env: Env, name: string, problems: string[]): string {
  const value = env[name]?.trim();
  if (!value) {
    problems.push(`${name} is required`);
    return "";
  }
  return value;
}

/**
 * Load configuration from an environment map (defaults to `Deno.env.toObject()`
 * at the call site).
 *
 * @throws {ConfigError} listing every missing or invalid variable.
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const appId = required(env, "GITHUB_APP_ID", problems);
  const rawKey = required(env, "GITHUB_APP_PRIVATE_KEY", problems);
  const clientId = required(env, "GITHUB_CLIENT_ID", problems);
  const clientSecret = required(env, "GITHUB_CLIENT_SECRET", problems);
  const jwtSecret = required(env, "CLAW_JWT_SECRET", problems);
  const rawBaseUrl = required(env, "BASE_URL", problems);
  // Unset → default public_repo; set (even to "") → used verbatim.
  const oauthScopes = env.GITHUB_OAUTH_SCOPES === undefined
    ? "public_repo"
    : env.GITHUB_OAUTH_SCOPES.trim();

  let privateKeyPem = "";
  if (rawKey) {
    try {
      privateKeyPem = normalizePrivateKey(rawKey);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  let baseUrl = "";
  if (rawBaseUrl) {
    try {
      baseUrl = new URL(rawBaseUrl).toString().replace(/\/$/, "");
    } catch {
      problems.push(`BASE_URL must be a valid URL (got "${rawBaseUrl}")`);
    }
  }

  let port = 8000;
  const rawPort = env.PORT?.trim();
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      problems.push(`PORT must be an integer between 1 and 65535 (got "${rawPort}")`);
    } else {
      port = parsed;
    }
  }

  const allowedLogin = env.ALLOWED_LOGIN?.trim() || "dtinth";
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET?.trim() || undefined;

  // Grist is optional; if GRIST_API_URL is set, the rest of the group is required.
  let grist: GristConfig | undefined;
  const rawGristUrl = env.GRIST_API_URL?.trim();
  if (rawGristUrl) {
    let apiUrl = "";
    try {
      apiUrl = new URL(rawGristUrl).toString().replace(/\/$/, "");
    } catch {
      problems.push(`GRIST_API_URL must be a valid URL (got "${rawGristUrl}")`);
    }
    const apiKey = env.GRIST_API_KEY?.trim();
    if (!apiKey) problems.push("GRIST_API_KEY is required when GRIST_API_URL is set");
    const table = env.GRIST_TABLE_ID?.trim() || "Comments";
    if (apiUrl && apiKey) grist = { apiUrl, apiKey, table };
  }

  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration:\n- ${problems.join("\n- ")}`);
  }

  return {
    appId,
    privateKeyPem,
    clientId,
    clientSecret,
    oauthScopes,
    jwtSecret,
    baseUrl,
    allowedLogin,
    port,
    webhookSecret,
    grist,
  };
}
