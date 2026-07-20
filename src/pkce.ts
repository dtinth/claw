/**
 * PKCE (RFC 7636) helpers for the OAuth flow.
 *
 * claw is a confidential client (it holds the client secret), so PKCE is used
 * here as defense-in-depth against authorization-code interception rather than
 * as a substitute for the secret — GitHub still requires the secret at the
 * token exchange. Only the S256 challenge method is supported.
 */
import { base64url } from "jose";

/** Generate a high-entropy code verifier (43 base64url chars from 32 bytes). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url.encode(bytes);
}

/** Compute the S256 code challenge (base64url of the SHA-256 of the verifier). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url.encode(new Uint8Array(digest));
}
