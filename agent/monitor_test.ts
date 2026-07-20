import { assertEquals, assertRejects } from "@std/assert";
import { diffNewComments, runMonitorLoop } from "./monitor.ts";
import type { RelayedComment } from "./comments_client.ts";

function comment(commentId: number): RelayedComment {
  return {
    commentId,
    repo: "dtinth/claw",
    issue: 24,
    author: "dtinth",
    authorId: 193136,
    body: `comment ${commentId}`,
    url: `https://github.com/dtinth/claw/issues/24#issuecomment-${commentId}`,
  };
}

// --- diffNewComments (pure) -------------------------------------------------

Deno.test("diffNewComments: empty fetch with no prior cursor stays null", () => {
  assertEquals(diffNewComments([], null), { newComments: [], nextCursor: null });
});

Deno.test("diffNewComments: empty fetch preserves an existing cursor", () => {
  assertEquals(diffNewComments([], 5), { newComments: [], nextCursor: 5 });
});

Deno.test("diffNewComments: first-ever run treats everything as new", () => {
  const comments = [comment(10), comment(20), comment(30)];
  const result = diffNewComments(comments, null);
  assertEquals(result.newComments, comments);
  assertEquals(result.nextCursor, 30);
});

Deno.test("diffNewComments: only comments after the cursor are new", () => {
  const comments = [comment(10), comment(20), comment(30)];
  const result = diffNewComments(comments, 20);
  assertEquals(result.newComments, [comment(30)]);
  assertEquals(result.nextCursor, 30);
});

Deno.test("diffNewComments: cursor never regresses below its prior value", () => {
  const comments = [comment(10), comment(20)];
  const result = diffNewComments(comments, 30);
  assertEquals(result.newComments, []);
  assertEquals(result.nextCursor, 30);
});

// --- runMonitorLoop ----------------------------------------------------------
//
// Stateless: the high-water-mark lives only as a local variable inside
// runMonitorLoop, for the life of one call. Nothing is written to disk, so
// these tests only ever check in-memory behavior across loop iterations
// within a single runMonitorLoop invocation.

function stopAfter(n: number): () => boolean {
  let count = 0;
  return () => {
    if (count >= n) return true;
    count++;
    return false;
  };
}

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

Deno.test("runMonitorLoop emits one JSON line per comment on the first poll", async () => {
  const stdout: string[] = [];
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ comments: [comment(1), comment(2)] }));

  await runMonitorLoop({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    intervalMs: 10_000,
    fetch: fetchFn,
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(1),
  });

  assertEquals(stdout, [JSON.stringify(comment(1)) + "\n", JSON.stringify(comment(2)) + "\n"]);
});

Deno.test("runMonitorLoop only emits comments newer than what it's already seen this run", async () => {
  const stdout: string[] = [];
  const { sleep } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    const comments = call === 1 ? [comment(1), comment(2)] : [comment(1), comment(2), comment(3)];
    return Promise.resolve(jsonResponse({ comments }));
  };

  await runMonitorLoop({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    intervalMs: 10_000,
    fetch: fetchFn,
    stdout: (t) => stdout.push(t),
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(2),
  });

  assertEquals(stdout, [
    JSON.stringify(comment(1)) + "\n",
    JSON.stringify(comment(2)) + "\n",
    JSON.stringify(comment(3)) + "\n",
  ]);
});

Deno.test("runMonitorLoop sleeps the configured interval between polls", async () => {
  const { sleep, calls } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ comments: [] }));

  await runMonitorLoop({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    intervalMs: 12_345,
    fetch: fetchFn,
    stdout: () => {},
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(3),
  });

  assertEquals(calls, [12_345, 12_345, 12_345]);
});

Deno.test("runMonitorLoop logs a transient (5xx) failure to stderr and keeps polling", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { sleep } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    if (call === 1) return Promise.resolve(jsonResponse({ error: "boom" }, 500));
    return Promise.resolve(jsonResponse({ comments: [comment(1)] }));
  };

  await runMonitorLoop({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    intervalMs: 10_000,
    fetch: fetchFn,
    stdout: (t) => stdout.push(t),
    stderr: (t) => stderr.push(t),
    sleep,
    shouldStop: stopAfter(2),
  });

  assertEquals(stdout, [JSON.stringify(comment(1)) + "\n"]);
  assertEquals(stderr.length, 1);
});

Deno.test("runMonitorLoop rethrows a fatal (401) failure instead of looping forever", async () => {
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ error: "token has expired" }, 401));

  await assertRejects(
    () =>
      runMonitorLoop({
        baseUrl: "https://claw.example.com",
        jwt: "expired.jwt",
        issue: 24,
        intervalMs: 10_000,
        fetch: fetchFn,
        stdout: () => {},
        stderr: () => {},
        sleep,
        // No shouldStop: the loop must exit on its own via the fatal error,
        // not by hitting an iteration bound.
      }),
    Error,
    "token has expired",
  );
});

Deno.test("runMonitorLoop forwards the authors filter to each poll", async () => {
  const seenAuthors: (string | null)[] = [];
  const { sleep } = collectingSleep();
  const fetchFn = (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    seenAuthors.push(url.searchParams.get("authors"));
    return Promise.resolve(jsonResponse({ comments: [] }));
  };

  await runMonitorLoop({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    authors: ["dtinth", "alice"],
    intervalMs: 10_000,
    fetch: fetchFn,
    stdout: () => {},
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(1),
  });

  assertEquals(seenAuthors, ["dtinth,alice"]);
});
