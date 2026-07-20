/**
 * Read-only decoding of a claw JWT's payload, for `claw grant`: the token's
 * `sub` claim already names the repo it's scoped to, so the CLI can figure
 * out where to file the grant without asking the user to repeat it.
 *
 * This does NOT verify the signature — the CLI never holds `CLAW_JWT_SECRET`
 * (by design, see the README). A forged payload only misfiles the grant
 * locally; the server re-verifies the real signature on every exchange.
 */
import { formatRepo, parseRepo, RepoError } from "./repo.ts";

export interface DecodedGrant {
  repo: string;
  label: string;
  permissions: Record<string, string>;
  /** `null` when the token has no (or an unparseable) `exp` claim. */
  expiresAt: Date | null;
}

/** Thrown when the token isn't a decodable claw JWT. */
export class JwtDecodeError extends Error {
  override name = "JwtDecodeError";
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new JwtDecodeError("could not decode the token payload (not valid base64)");
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Decode (without verifying) a claw JWT's payload.
 *
 * @throws {JwtDecodeError} when the token isn't shaped like a claw JWT, or
 * has no repository (`sub`) claim.
 */
export function decodeClawJwtPayload(token: string): DecodedGrant {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    throw new JwtDecodeError("not a JWT (expected three dot-separated parts)");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(parts[1]!));
  } catch (error) {
    if (error instanceof JwtDecodeError) throw error;
    throw new JwtDecodeError("could not parse the token payload as JSON");
  }
  if (payload === null || typeof payload !== "object") {
    throw new JwtDecodeError("token payload is not an object");
  }
  const data = payload as Record<string, unknown>;

  if (typeof data.sub !== "string") {
    throw new JwtDecodeError("token has no repository (sub) claim — is this a claw JWT?");
  }
  let repo: string;
  try {
    repo = formatRepo(parseRepo(data.sub));
  } catch (error) {
    throw new JwtDecodeError(
      `token's repository claim is invalid: ${
        error instanceof RepoError ? error.message : data.sub
      }`,
    );
  }

  const perms = data.perms;
  return {
    repo,
    label: typeof data.label === "string" ? data.label : "",
    permissions: perms !== null && typeof perms === "object" ? perms as Record<string, string> : {},
    expiresAt: typeof data.exp === "number" ? new Date(data.exp * 1000) : null,
  };
}
