import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  findGrant,
  GrantsError,
  loadGrants,
  pickFurthestExpiringGrant,
  upsertGrant,
} from "./grants.ts";

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeClawJwt(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.not-a-real-signature`;
}

async function withTempFile(content: string | undefined, fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/grants.json`;
  try {
    if (content !== undefined) await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadGrants parses a valid grants file", async () => {
  await withTempFile(
    JSON.stringify({ "dtinth/claw": "the.jwt.token", "dtinth/other": "another.jwt.token" }),
    async (path) => {
      const grants = await loadGrants(path);
      assertEquals(grants["dtinth/claw"], "the.jwt.token");
      assertEquals(grants["dtinth/other"], "another.jwt.token");
    },
  );
});

Deno.test("loadGrants throws a GrantsError when the file is missing", async () => {
  await withTempFile(undefined, async (path) => {
    await assertRejects(() => loadGrants(path), GrantsError);
  });
});

Deno.test("loadGrants throws a GrantsError on invalid JSON", async () => {
  await withTempFile("not json", async (path) => {
    await assertRejects(() => loadGrants(path), GrantsError);
  });
});

Deno.test("loadGrants throws a GrantsError when the JSON isn't an object", async () => {
  await withTempFile(JSON.stringify(["dtinth/claw"]), async (path) => {
    await assertRejects(() => loadGrants(path), GrantsError);
  });
});

Deno.test("loadGrants throws a GrantsError on a non-string grant value", async () => {
  await withTempFile(JSON.stringify({ "dtinth/claw": 123 }), async (path) => {
    await assertRejects(() => loadGrants(path), GrantsError);
  });
});

Deno.test("loadGrants throws a GrantsError on an empty-string grant value", async () => {
  await withTempFile(JSON.stringify({ "dtinth/claw": "" }), async (path) => {
    await assertRejects(() => loadGrants(path), GrantsError);
  });
});

Deno.test("findGrant returns the grant for a known repo", () => {
  const jwt = findGrant({ "dtinth/claw": "the.jwt" }, "dtinth/claw");
  assertEquals(jwt, "the.jwt");
});

Deno.test("findGrant throws a GrantsError for an unknown repo", () => {
  assertThrows(() => findGrant({}, "dtinth/claw"), GrantsError);
});

Deno.test("upsertGrant creates the file and directory when neither exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/nested/grants.json`;
    const result = await upsertGrant(path, "dtinth/claw", "the.jwt");
    assertEquals(result.replaced, false);
    const grants = await loadGrants(path);
    assertEquals(grants, { "dtinth/claw": "the.jwt" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("upsertGrant adds to an existing file without disturbing other grants", async () => {
  await withTempFile(JSON.stringify({ "dtinth/other": "other.jwt" }), async (path) => {
    const result = await upsertGrant(path, "dtinth/claw", "the.jwt");
    assertEquals(result.replaced, false);
    const grants = await loadGrants(path);
    assertEquals(grants, { "dtinth/other": "other.jwt", "dtinth/claw": "the.jwt" });
  });
});

Deno.test("upsertGrant reports replaced:true and overwrites an existing grant for the same repo", async () => {
  await withTempFile(JSON.stringify({ "dtinth/claw": "old.jwt" }), async (path) => {
    const result = await upsertGrant(path, "dtinth/claw", "new.jwt");
    assertEquals(result.replaced, true);
    const grants = await loadGrants(path);
    assertEquals(grants, { "dtinth/claw": "new.jwt" });
  });
});

Deno.test("upsertGrant refuses to clobber a malformed existing file", async () => {
  await withTempFile("not json", async (path) => {
    await assertRejects(() => upsertGrant(path, "dtinth/claw", "the.jwt"), GrantsError);
    // The original (broken) content must be untouched.
    assertEquals(await Deno.readTextFile(path), "not json");
  });
});

Deno.test("pickFurthestExpiringGrant picks the grant with the latest exp claim", () => {
  const soon = fakeClawJwt({ sub: "dtinth/a", exp: 1000 });
  const later = fakeClawJwt({ sub: "dtinth/b", exp: 5000 });
  const store = { "dtinth/a": soon, "dtinth/b": later };
  assertEquals(pickFurthestExpiringGrant(store), later);
});

Deno.test("pickFurthestExpiringGrant treats a missing exp claim as furthest-out", () => {
  const soon = fakeClawJwt({ sub: "dtinth/a", exp: 1000 });
  const noExpiry = fakeClawJwt({ sub: "dtinth/b" });
  const store = { "dtinth/a": soon, "dtinth/b": noExpiry };
  assertEquals(pickFurthestExpiringGrant(store), noExpiry);
});

Deno.test("pickFurthestExpiringGrant skips a grant that doesn't decode as a claw JWT", () => {
  const good = fakeClawJwt({ sub: "dtinth/a", exp: 1000 });
  const store = { "dtinth/broken": "not-a-jwt", "dtinth/a": good };
  assertEquals(pickFurthestExpiringGrant(store), good);
});

Deno.test("pickFurthestExpiringGrant throws when there are no usable grants", () => {
  assertThrows(() => pickFurthestExpiringGrant({}), GrantsError);
  assertThrows(() => pickFurthestExpiringGrant({ "dtinth/a": "not-a-jwt" }), GrantsError);
});
