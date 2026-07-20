/**
 * The intermediary "claw JWT" — claw's own signed token that you mint from the
 * web UI and hand to a coding agent. It is signed with a shared secret
 * (HS256) and encodes the repository, the requested permissions and an expiry.
 * The agent later exchanges it, via `POST /api/token`, for a short-lived
 * GitHub App installation token scoped to exactly that repository.
 */
import { errors, jwtVerify, SignJWT } from "jose";
import { parseRepo } from "./github/repo.ts";
import { isEmptyPermissions, parsePermissions, type Permissions } from "./permissions.ts";

const ISSUER = "claw";
const ALG = "HS256";

/** Parameters for minting a claw JWT. */
export interface CreateClawJwtParams {
  /** The repository the grant is scoped to, as `owner/repo`. */
  repo: string;
  /** The permissions the minted installation token should carry. */
  permissions: Permissions;
  /** Lifetime of the JWT in seconds. Must be positive. */
  ttlSeconds: number;
  /** Optional human label to identify the grant (e.g. the agent's name). */
  label?: string;
  /** Override the issued-at time; used in tests. Defaults to now. */
  now?: Date;
}

/** A verified claw JWT, decoded into a structured grant. */
export interface ClawGrant {
  /** The repository the grant is scoped to, as `owner/repo`. */
  repo: string;
  /** The permissions to request on the installation token. */
  permissions: Permissions;
  /** Human label for the grant; empty string when none was set. */
  label: string;
  /** The JWT id (`jti`). */
  jti: string;
  /** When the token was issued. */
  issuedAt: Date;
  /** When the token expires. */
  expiresAt: Date;
}

/** Thrown when a claw JWT cannot be created or verified. */
export class ClawJwtError extends Error {
  override name = "ClawJwtError";
}

function secretKey(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new ClawJwtError("signing secret must not be empty");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Mint a claw JWT.
 *
 * @throws {ClawJwtError} for an invalid repo, empty permissions (which would
 * grant full app access) or a non-positive lifetime.
 */
export async function createClawJwt(
  params: CreateClawJwtParams,
  secret: string,
): Promise<string> {
  const { repo, permissions, ttlSeconds, label = "", now = new Date() } = params;

  // Validate up front so callers fail fast rather than at exchange time.
  try {
    parseRepo(repo);
  } catch (error) {
    throw new ClawJwtError(error instanceof Error ? error.message : String(error));
  }
  if (isEmptyPermissions(permissions)) {
    throw new ClawJwtError("a grant must include at least one permission");
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new ClawJwtError("lifetime (ttlSeconds) must be a positive number");
  }

  const key = secretKey(secret);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + Math.floor(ttlSeconds);

  return await new SignJWT({ perms: permissions, label })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setIssuer(ISSUER)
    .setSubject(repo)
    .setJti(crypto.randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
}

/**
 * Verify a claw JWT and decode it into a {@link ClawGrant}.
 *
 * @throws {ClawJwtError} when the signature is invalid, the token is expired,
 * or the payload is malformed.
 */
export async function verifyClawJwt(token: string, secret: string): Promise<ClawGrant> {
  const key = secretKey(secret);
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, { issuer: ISSUER, algorithms: [ALG] }));
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      throw new ClawJwtError("token has expired");
    }
    throw new ClawJwtError(
      `invalid token: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const repo = typeof payload.sub === "string" ? payload.sub : "";
  try {
    parseRepo(repo);
  } catch {
    throw new ClawJwtError("token is missing a valid repository");
  }

  const rawPerms = payload.perms;
  if (rawPerms === null || typeof rawPerms !== "object") {
    throw new ClawJwtError("token is missing permissions");
  }
  let permissions: Permissions;
  try {
    permissions = parsePermissions(rawPerms as Record<string, string>);
  } catch (error) {
    throw new ClawJwtError(
      `token has invalid permissions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (isEmptyPermissions(permissions)) {
    throw new ClawJwtError("token grants no permissions");
  }

  if (payload.iat === undefined || payload.exp === undefined || payload.jti === undefined) {
    throw new ClawJwtError("token is missing standard claims");
  }

  return {
    repo,
    permissions,
    label: typeof payload.label === "string" ? payload.label : "",
    jti: payload.jti,
    issuedAt: new Date(payload.iat * 1000),
    expiresAt: new Date(payload.exp * 1000),
  };
}
