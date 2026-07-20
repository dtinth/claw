/**
 * Minting the GitHub App JWT — the short-lived RS256 token, signed with the
 * app's private key, that authenticates claw *as the app* when looking up
 * installations and creating installation access tokens.
 *
 * GitHub App private keys are distributed in PKCS#1 form
 * (`-----BEGIN RSA PRIVATE KEY-----`). `node:crypto`'s signer accepts that PEM
 * directly, so no key-format conversion is needed.
 */
import { createSign } from "node:crypto";
import { base64url } from "jose";

function base64urlJson(value: unknown): string {
  return base64url.encode(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Create a GitHub App JWT valid for ~10 minutes.
 *
 * @param appId The GitHub App's numeric id (the `iss` claim).
 * @param privateKeyPem The app private key in PEM form (PKCS#1 or PKCS#8).
 * @param now Current time; injectable for tests. Defaults to now.
 */
export function createAppJwt(appId: string, privateKeyPem: string, now: Date = new Date()): string {
  const seconds = Math.floor(now.getTime() / 1000);
  // Backdate iat by 60s to tolerate clock drift between claw and GitHub.
  const iat = seconds - 60;
  const exp = seconds + 600; // GitHub rejects app JWTs older than 10 minutes.

  const signingInput = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${
    base64urlJson({ iat, exp, iss: appId })
  }`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem);

  return `${signingInput}.${base64url.encode(new Uint8Array(signature))}`;
}
