import { assertEquals } from "@std/assert";
import { decodeSession, encodeSession, type Session } from "./session.ts";

const SECRET = "session-encryption-secret";

const sample: Session = {
  login: "dtinth",
  accessToken: "ghu_usertoken",
  createdAt: "2026-07-20T00:00:00.000Z",
};

Deno.test("encodeSession + decodeSession round-trips a session", async () => {
  const cookie = await encodeSession(sample, SECRET, 3600);
  assertEquals(await decodeSession(cookie, SECRET), sample);
});

Deno.test("encodeSession preserves optional fields", async () => {
  const full: Session = {
    ...sample,
    refreshToken: "ghr_refresh",
    accessTokenExpiresAt: "2026-07-21T00:00:00.000Z",
  };
  const cookie = await encodeSession(full, SECRET, 3600);
  assertEquals(await decodeSession(cookie, SECRET), full);
});

Deno.test("decodeSession rejects a cookie encrypted with a different secret", async () => {
  const cookie = await encodeSession(sample, SECRET, 3600);
  assertEquals(await decodeSession(cookie, "other-secret"), null);
});

Deno.test("decodeSession rejects a tampered cookie", async () => {
  const cookie = await encodeSession(sample, SECRET, 3600);
  assertEquals(await decodeSession(cookie.slice(0, -4) + "aaaa", SECRET), null);
});

Deno.test("decodeSession rejects an expired cookie", async () => {
  const cookie = await encodeSession(sample, SECRET, -100); // already expired
  assertEquals(await decodeSession(cookie, SECRET), null);
});

Deno.test("decodeSession rejects garbage", async () => {
  assertEquals(await decodeSession("not-a-jwe", SECRET), null);
  assertEquals(await decodeSession("", SECRET), null);
});
