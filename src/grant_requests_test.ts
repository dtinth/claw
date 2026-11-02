import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { createGrantRequestStore, GrantRequestError } from "./grant_requests.ts";

/** One scripted Uint8Array per call, regardless of the requested length — lets a test control exactly what each `randomBytes()` call returns. */
function scriptedRandomBytes(calls: number[][]) {
  let i = 0;
  return (_n: number): Uint8Array => {
    const bytes = calls[i++];
    if (!bytes) throw new Error("scriptedRandomBytes: ran out of scripted calls");
    return new Uint8Array(bytes);
  };
}

function fakeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const GRANT = { token: "the.claw.jwt", expiresAt: "2026-07-24T18:30:00Z" };

Deno.test("create returns a secret and a 6-character code, and an expiresInSeconds matching the TTL", () => {
  const store = createGrantRequestStore({ ttlMs: 15 * 60 * 1000 });
  const result = store.create("dtinth/claw");
  assertEquals(result.code.length, 6);
  assertNotEquals(result.secret, result.code);
  assertEquals(result.expiresInSeconds, 900);
});

Deno.test("create rejects a malformed repo", () => {
  const store = createGrantRequestStore();
  assertThrows(() => store.create("not-a-repo"), GrantRequestError);
});

Deno.test("create rejects an overlong reason", () => {
  const store = createGrantRequestStore();
  assertThrows(() => store.create("dtinth/claw", "x".repeat(501)), GrantRequestError);
});

Deno.test("create rejects once the store is at capacity", () => {
  const store = createGrantRequestStore({ maxPending: 2 });
  store.create("dtinth/claw");
  store.create("dtinth/claw");
  assertThrows(() => store.create("dtinth/claw"), GrantRequestError, "too many pending");
});

Deno.test("create regenerates the code on a collision rather than returning a duplicate", () => {
  const secretBytes = new Array(32).fill(9);
  const codeBytesA = new Array(6).fill(0); // → "AAAAAA"
  const codeBytesB = new Array(6).fill(1); // → "BBBBBB"
  // 1st create: secret, then code "AAAAAA". 2nd create: secret, then a first
  // code attempt that collides with "AAAAAA" again — forcing a retry that
  // must draw fresh bytes (codeBytesB) rather than reuse the colliding draw.
  const bytes = scriptedRandomBytes([secretBytes, codeBytesA, secretBytes, codeBytesA, codeBytesB]);
  const store = createGrantRequestStore({ randomBytes: bytes });
  const first = store.create("dtinth/claw");
  const second = store.create("dtinth/claw");
  assertEquals(first.code, "AAAAAA");
  assertEquals(second.code, "BBBBBB");
});

Deno.test("lookupByCode finds a pending request by its code, with the reason if given", () => {
  const store = createGrantRequestStore();
  const { code } = store.create("dtinth/claw", "fixing a bug");
  assertEquals(store.lookupByCode(code), { repo: "dtinth/claw", reason: "fixing a bug" });
});

Deno.test("lookupByCode omits reason when none was given", () => {
  const store = createGrantRequestStore();
  const { code } = store.create("dtinth/claw");
  assertEquals(store.lookupByCode(code), { repo: "dtinth/claw" });
});

Deno.test("lookupByCode returns undefined for an unknown code", () => {
  const store = createGrantRequestStore();
  assertEquals(store.lookupByCode("ZZZZZZ"), undefined);
});

Deno.test("lookupByCode never finds the secret as if it were a code (distinct values)", () => {
  const store = createGrantRequestStore();
  const { secret } = store.create("dtinth/claw");
  assertEquals(store.lookupByCode(secret), undefined);
});

Deno.test("poll reports pending until approved", () => {
  const store = createGrantRequestStore();
  const { secret } = store.create("dtinth/claw");
  assertEquals(store.poll(secret), { status: "pending" });
});

Deno.test("poll reports not_found for an unknown secret", () => {
  const store = createGrantRequestStore();
  assertEquals(store.poll("nope"), { status: "not_found" });
});

Deno.test("approve then poll hands the agent the grant", () => {
  const store = createGrantRequestStore();
  const { secret, code } = store.create("dtinth/claw");
  assertEquals(store.approve(code, GRANT), true);
  assertEquals(store.poll(secret), { status: "approved", grant: GRANT });
});

Deno.test("approve returns false for an unknown code", () => {
  const store = createGrantRequestStore();
  assertEquals(store.approve("ZZZZZZ", GRANT), false);
});

Deno.test("poll consumes the request once approved — a second poll sees not_found, so the grant can't be claimed twice", () => {
  const store = createGrantRequestStore();
  const { secret, code } = store.create("dtinth/claw");
  store.approve(code, GRANT);
  store.poll(secret);
  assertEquals(store.poll(secret), { status: "not_found" });
});

Deno.test("an expired request is pruned — lookupByCode, approve and poll all stop seeing it", () => {
  const clock = fakeClock(0);
  const store = createGrantRequestStore({ now: clock.now, ttlMs: 1000 });
  const { secret, code } = store.create("dtinth/claw");
  clock.advance(1001);
  assertEquals(store.lookupByCode(code), undefined);
  assertEquals(store.approve(code, GRANT), false);
  assertEquals(store.poll(secret), { status: "not_found" });
});

Deno.test("an expired request frees up room in a full store", () => {
  const clock = fakeClock(0);
  const store = createGrantRequestStore({ now: clock.now, ttlMs: 1000, maxPending: 1 });
  store.create("dtinth/claw");
  clock.advance(1001);
  // Would throw ("too many pending") if the expired entry weren't pruned first.
  store.create("dtinth/other");
});

Deno.test("an approved-but-never-polled request still expires eventually (backstop against a crashed agent)", () => {
  const clock = fakeClock(0);
  const store = createGrantRequestStore({ now: clock.now, ttlMs: 1000 });
  const { secret, code } = store.create("dtinth/claw");
  store.approve(code, GRANT);
  clock.advance(1001);
  assertEquals(store.poll(secret), { status: "not_found" });
});
