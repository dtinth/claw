import { assertEquals, assertRejects } from "@std/assert";
import { runAwaitGrant } from "./await_grant.ts";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function collectingSleep() {
  const calls: number[] = [];
  return { sleep: (ms: number) => (calls.push(ms), Promise.resolve()), calls };
}

function fakeClock(startMs: number) {
  let t = startMs;
  return { now: () => t, sleep: (ms: number) => (t += ms, Promise.resolve()) };
}

function stopAfter(n: number): () => boolean {
  let count = 0;
  return () => {
    if (count >= n) return true;
    count++;
    return false;
  };
}

Deno.test("runAwaitGrant returns immediately when already approved on the first poll", async () => {
  const { sleep, calls } = collectingSleep();
  const fetchFn = () =>
    Promise.resolve(
      jsonResponse({ status: "approved", token: "the.jwt", expiresAt: "2026-08-01T00:00:00Z" }),
    );

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(result, { status: "approved", token: "the.jwt", expiresAt: "2026-08-01T00:00:00Z" });
  assertEquals(calls, []);
});

Deno.test("runAwaitGrant keeps polling (sleeping between pending polls) until approved", async () => {
  const { sleep, calls } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    return Promise.resolve(
      call < 3
        ? jsonResponse({ status: "pending" })
        : jsonResponse({ status: "approved", token: "the.jwt", expiresAt: "2026-08-01T00:00:00Z" }),
    );
  };

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 5_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(result, { status: "approved", token: "the.jwt", expiresAt: "2026-08-01T00:00:00Z" });
  assertEquals(calls, [5_000, 5_000]);
});

Deno.test("runAwaitGrant logs a transient (5xx) failure to stderr and keeps polling", async () => {
  const stderr: string[] = [];
  const { sleep } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    if (call === 1) return Promise.resolve(jsonResponse({ error: "boom" }, 500));
    return Promise.resolve(jsonResponse({ status: "approved", token: "t", expiresAt: "e" }));
  };

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: (t) => stderr.push(t),
    sleep,
  });

  assertEquals(result, { status: "approved", token: "t", expiresAt: "e" });
  assertEquals(stderr.length, 1);
});

Deno.test("runAwaitGrant rethrows a fatal (404: expired/unknown secret) failure instead of looping forever", async () => {
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ error: "no such grant request" }, 404));

  await assertRejects(
    () =>
      runAwaitGrant({
        baseUrl: "https://claw.example.com",
        secret: "gone",
        intervalMs: 10_000,
        fetch: fetchFn,
        stderr: () => {},
        sleep,
      }),
    Error,
    "no such grant request",
  );
});

Deno.test("runAwaitGrant gives up with status timed_out once shouldStop says so (test-only escape hatch)", async () => {
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ status: "pending" }));

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(3),
  });

  assertEquals(result, { status: "timed_out" });
});

Deno.test("runAwaitGrant gives up with status timed_out once timeoutMs elapses with no approval", async () => {
  const clock = fakeClock(0);
  let fetchCalls = 0;
  const fetchFn = () => {
    fetchCalls++;
    return Promise.resolve(jsonResponse({ status: "pending" }));
  };

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 1_000,
    timeoutMs: 2_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep: clock.sleep,
    now: clock.now,
  });

  assertEquals(result, { status: "timed_out" });
  assertEquals(fetchCalls, 3); // polls at t=0, 1000, 2000, then gives up
});

Deno.test("runAwaitGrant returns approved if found just before timeoutMs would have elapsed", async () => {
  const clock = fakeClock(0);
  let call = 0;
  const fetchFn = () => {
    call++;
    return Promise.resolve(
      call < 2
        ? jsonResponse({ status: "pending" })
        : jsonResponse({ status: "approved", token: "t", expiresAt: "e" }),
    );
  };

  const result = await runAwaitGrant({
    baseUrl: "https://claw.example.com",
    secret: "the-secret",
    intervalMs: 1_000,
    timeoutMs: 5_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep: clock.sleep,
    now: clock.now,
  });

  assertEquals(result, { status: "approved", token: "t", expiresAt: "e" });
});
