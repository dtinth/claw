import { assertEquals, assertRejects } from "@std/assert";
import { getToken } from "./token.ts";
import { GrantsError } from "./grants.ts";
import { readCache, writeCache } from "./cache.ts";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function fakeFetch(handler: () => Response) {
  let calls = 0;
  const fn = (): Promise<Response> => {
    calls++;
    return Promise.resolve(handler());
  };
  return { fn, getCalls: () => calls };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

Deno.test("getToken mints and caches when nothing is cached yet", async () => {
  await withTempDir(async (cacheDir) => {
    const { fn, getCalls } = fakeFetch(() =>
      json({
        token: "ghs_fresh",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      })
    );
    const result = await getToken({
      repo: "dtinth/claw",
      grants: { "dtinth/claw": "the.jwt" },
      cacheDir,
      baseUrl: "https://claw.example.com",
      fetch: fn,
      now: new Date("2026-07-21T00:00:00Z"),
    });
    assertEquals(result.token, "ghs_fresh");
    assertEquals(getCalls(), 1);
    assertEquals((await readCache(cacheDir, "dtinth/claw"))?.token, "ghs_fresh");
  });
});

Deno.test("getToken reuses a fresh cached token without minting", async () => {
  await withTempDir(async (cacheDir) => {
    await writeCache(cacheDir, "dtinth/claw", {
      token: "ghs_cached",
      expiresAt: "2026-07-21T01:00:00Z",
    });
    const { fn, getCalls } = fakeFetch(() => {
      throw new Error("must not mint when cache is fresh");
    });
    const result = await getToken({
      repo: "dtinth/claw",
      grants: { "dtinth/claw": "the.jwt" },
      cacheDir,
      baseUrl: "https://claw.example.com",
      fetch: fn,
      now: new Date("2026-07-21T00:00:00Z"),
    });
    assertEquals(result.token, "ghs_cached");
    assertEquals(getCalls(), 0);
  });
});

Deno.test("getToken re-mints when the cached token is inside the freshness margin", async () => {
  await withTempDir(async (cacheDir) => {
    await writeCache(cacheDir, "dtinth/claw", {
      token: "ghs_stale",
      expiresAt: "2026-07-21T01:00:00Z",
    });
    const { fn, getCalls } = fakeFetch(() =>
      json({
        token: "ghs_renewed",
        expires_at: "2026-07-21T02:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      })
    );
    const result = await getToken({
      repo: "dtinth/claw",
      grants: { "dtinth/claw": "the.jwt" },
      cacheDir,
      baseUrl: "https://claw.example.com",
      fetch: fn,
      // 2 minutes left — inside the 5-minute margin.
      now: new Date("2026-07-21T00:58:00Z"),
    });
    assertEquals(result.token, "ghs_renewed");
    assertEquals(getCalls(), 1);
  });
});

Deno.test("getToken throws a GrantsError when no grant exists for the repo", async () => {
  await withTempDir(async (cacheDir) => {
    const { fn } = fakeFetch(() => {
      throw new Error("must not be called");
    });
    await assertRejects(
      () =>
        getToken({
          repo: "dtinth/claw",
          grants: {},
          cacheDir,
          baseUrl: "https://claw.example.com",
          fetch: fn,
        }),
      GrantsError,
    );
  });
});
