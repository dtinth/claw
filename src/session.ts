/**
 * Stateless browser sessions.
 *
 * The logged-in user's GitHub token is carried in an **encrypted** (JWE,
 * `dir` + A256GCM) cookie rather than stored server-side, so claw keeps no
 * session state. The encryption key is derived from a server secret, so the
 * cookie is opaque and tamper-proof; being httpOnly it is never exposed to
 * page JavaScript. Sessions expire after a fixed window (you re-authenticate).
 */
import { EncryptJWT, jwtDecrypt } from "jose";

/** A logged-in session for the single permitted user. */
export interface Session {
  login: string;
  /** GitHub user-to-server access token, used to post comments as the user. */
  accessToken: string;
  /** Refresh token, when the app issues expiring user tokens. */
  refreshToken?: string;
  /** ISO-8601 expiry of the access token, when known. */
  accessTokenExpiresAt?: string;
  createdAt: string;
}

async function deriveKey(secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return new Uint8Array(digest); // 32 bytes for A256GCM
}

/** Encrypt a session into a cookie value that expires after `ttlSeconds`. */
export async function encodeSession(
  session: Session,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const key = await deriveKey(secret);
  const exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  return await new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .encrypt(key);
}

/** Decrypt and validate a session cookie; returns null if invalid or expired. */
export async function decodeSession(cookie: string, secret: string): Promise<Session | null> {
  if (!cookie) return null;
  try {
    const key = await deriveKey(secret);
    const { payload } = await jwtDecrypt(cookie, key);
    if (typeof payload.login !== "string" || typeof payload.accessToken !== "string") {
      return null;
    }
    const session: Session = {
      login: payload.login,
      accessToken: payload.accessToken,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : "",
    };
    if (typeof payload.refreshToken === "string") session.refreshToken = payload.refreshToken;
    if (typeof payload.accessTokenExpiresAt === "string") {
      session.accessTokenExpiresAt = payload.accessTokenExpiresAt;
    }
    return session;
  } catch {
    return null;
  }
}
