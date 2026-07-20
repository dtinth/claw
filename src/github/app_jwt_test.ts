import { assertEquals } from "@std/assert";
import { Buffer } from "node:buffer";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createAppJwt } from "./app_jwt.ts";

function keypair() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, // GitHub's format
  });
}

function decodeSegment(seg: string): Record<string, unknown> {
  const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  return JSON.parse(json);
}

Deno.test("createAppJwt produces an RS256 JWT with app claims", () => {
  const { privateKey } = keypair();
  const now = new Date("2026-07-20T00:00:00Z");
  const jwt = createAppJwt("123456", privateKey, now);

  const [headerSeg, payloadSeg] = jwt.split(".");
  assertEquals(decodeSegment(headerSeg!), { alg: "RS256", typ: "JWT" });

  const payload = decodeSegment(payloadSeg!);
  assertEquals(payload.iss, "123456");
  const nowSec = Math.floor(now.getTime() / 1000);
  // iat is backdated slightly for clock skew; exp within 10 minutes.
  assertEquals((payload.iat as number) <= nowSec, true);
  assertEquals((payload.exp as number) <= nowSec + 600, true);
  assertEquals((payload.exp as number) > nowSec, true);
});

Deno.test("createAppJwt signature verifies against the public key", () => {
  const { privateKey, publicKey } = keypair();
  const jwt = createAppJwt("123456", privateKey);
  const [headerSeg, payloadSeg, sigSeg] = jwt.split(".");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerSeg}.${payloadSeg}`);
  const signature = Buffer.from(sigSeg!.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assertEquals(verifier.verify(publicKey, signature), true);
});
