import { assertEquals, assertThrows } from "@std/assert";
import { decodeClawJwtPayload, JwtDecodeError } from "./jwt_decode.ts";

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.not-a-real-signature`;
}

Deno.test("decodeClawJwtPayload extracts repo, permissions, label and expiry", () => {
  const token = fakeJwt({
    sub: "dtinth/claw",
    perms: { contents: "write", issues: "read" },
    label: "my-agent",
    exp: 1_800_000_000,
    iat: 1_797_000_000,
  });
  const decoded = decodeClawJwtPayload(token);
  assertEquals(decoded.repo, "dtinth/claw");
  assertEquals(decoded.permissions, { contents: "write", issues: "read" });
  assertEquals(decoded.label, "my-agent");
  assertEquals(decoded.expiresAt?.getTime(), 1_800_000_000 * 1000);
});

Deno.test("decodeClawJwtPayload defaults label to empty and permissions to {}", () => {
  const decoded = decodeClawJwtPayload(fakeJwt({ sub: "dtinth/claw" }));
  assertEquals(decoded.label, "");
  assertEquals(decoded.permissions, {});
  assertEquals(decoded.expiresAt, null);
});

Deno.test("decodeClawJwtPayload handles a unicode label correctly", () => {
  const decoded = decodeClawJwtPayload(fakeJwt({ sub: "dtinth/claw", label: "agent 🤖" }));
  assertEquals(decoded.label, "agent 🤖");
});

Deno.test("decodeClawJwtPayload throws for something that isn't three dot-separated parts", () => {
  assertThrows(() => decodeClawJwtPayload("not-a-jwt"), JwtDecodeError);
  assertThrows(() => decodeClawJwtPayload("a.b"), JwtDecodeError);
});

Deno.test("decodeClawJwtPayload throws when the payload segment isn't valid base64/JSON", () => {
  assertThrows(() => decodeClawJwtPayload("a.not-valid-base64!!!.c"), JwtDecodeError);
});

Deno.test("decodeClawJwtPayload throws when sub is missing", () => {
  assertThrows(() => decodeClawJwtPayload(fakeJwt({ perms: {} })), JwtDecodeError);
});

Deno.test("decodeClawJwtPayload throws when sub isn't a well-formed owner/repo", () => {
  assertThrows(() => decodeClawJwtPayload(fakeJwt({ sub: "not-a-repo" })), JwtDecodeError);
});

Deno.test("decodeClawJwtPayload tolerates surrounding whitespace", () => {
  const token = fakeJwt({ sub: "dtinth/claw" });
  const decoded = decodeClawJwtPayload(`  ${token}  \n`);
  assertEquals(decoded.repo, "dtinth/claw");
});
