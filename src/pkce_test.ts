import { assertEquals, assertNotEquals } from "@std/assert";
import { createHash } from "node:crypto";
import { base64url } from "jose";
import { codeChallenge, generateCodeVerifier } from "./pkce.ts";

Deno.test("generateCodeVerifier returns a 43-char base64url string", () => {
  const verifier = generateCodeVerifier();
  assertEquals(verifier.length, 43); // 32 bytes → 43 base64url chars
  assertEquals(/^[A-Za-z0-9_-]+$/.test(verifier), true);
});

Deno.test("generateCodeVerifier is random each call", () => {
  assertNotEquals(generateCodeVerifier(), generateCodeVerifier());
});

Deno.test("codeChallenge is the S256 (base64url SHA-256) of the verifier", async () => {
  const verifier = "test-verifier-value";
  const expected = base64url.encode(createHash("sha256").update(verifier).digest());
  assertEquals(await codeChallenge(verifier), expected);
});
