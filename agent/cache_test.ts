import { assertEquals } from "@std/assert";
import { cachePath, isFresh, readCache, writeCache } from "./cache.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("cachePath encodes owner/repo as owner__repo.json", () => {
  assertEquals(cachePath("/cache/claw", "dtinth/claw"), "/cache/claw/dtinth__claw.json");
});

Deno.test("readCache returns null when nothing is cached yet", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await readCache(dir, "dtinth/claw"), null);
  });
});

Deno.test("writeCache then readCache round-trips the entry", async () => {
  await withTempDir(async (dir) => {
    await writeCache(dir, "dtinth/claw", {
      token: "ghs_abc",
      expiresAt: "2026-07-21T01:00:00Z",
    });
    const entry = await readCache(dir, "dtinth/claw");
    assertEquals(entry, { token: "ghs_abc", expiresAt: "2026-07-21T01:00:00Z" });
  });
});

Deno.test("writeCache creates the cache directory if missing", async () => {
  await withTempDir(async (dir) => {
    const nested = `${dir}/nested/claw`;
    await writeCache(nested, "dtinth/claw", { token: "ghs_x", expiresAt: "2026-07-21T01:00:00Z" });
    assertEquals((await readCache(nested, "dtinth/claw"))?.token, "ghs_x");
  });
});

Deno.test("readCache returns null for garbage content instead of throwing", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(cachePath(dir, "dtinth/claw"), "not json");
    assertEquals(await readCache(dir, "dtinth/claw"), null);
  });
});

Deno.test("isFresh is true well before expiry", () => {
  const entry = { token: "t", expiresAt: "2026-07-21T01:00:00Z" };
  const now = new Date("2026-07-21T00:00:00Z");
  assertEquals(isFresh(entry, now), true);
});

Deno.test("isFresh is false inside the 5-minute safety margin", () => {
  const entry = { token: "t", expiresAt: "2026-07-21T01:00:00Z" };
  const now = new Date("2026-07-21T00:57:00Z");
  assertEquals(isFresh(entry, now), false);
});

Deno.test("isFresh is false once expired", () => {
  const entry = { token: "t", expiresAt: "2026-07-21T01:00:00Z" };
  const now = new Date("2026-07-21T02:00:00Z");
  assertEquals(isFresh(entry, now), false);
});

Deno.test("isFresh is false for an unparseable expiry", () => {
  const entry = { token: "t", expiresAt: "not a date" };
  assertEquals(isFresh(entry, new Date()), false);
});
