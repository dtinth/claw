import { assertEquals, assertRejects } from "@std/assert";
import { filterComments, runLongPoll } from "./read.ts";
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

// --- filterComments (pure) --------------------------------------------------

Deno.test("filterComments: with no bounds, keeps everything", () => {
  const comments = [comment(10), comment(20)];
  assertEquals(filterComments(comments, {}), comments);
});

Deno.test("filterComments: --after keeps only comments with a strictly greater id", () => {
  const comments = [comment(10), comment(20), comment(30)];
  assertEquals(filterComments(comments, { after: 20 }), [comment(30)]);
});

Deno.test("filterComments: --before keeps only comments with a strictly smaller id", () => {
  const comments = [comment(10), comment(20), comment(30)];
  assertEquals(filterComments(comments, { before: 20 }), [comment(10)]);
});

Deno.test("filterComments: --after and --before together bound a range on both sides", () => {
  const comments = [comment(10), comment(20), comment(30), comment(40)];
  assertEquals(filterComments(comments, { after: 10, before: 40 }), [comment(20), comment(30)]);
});

// --- runLongPoll -------------------------------------------------------------

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

Deno.test("runLongPoll returns immediately when the first poll already has a match", async () => {
  const { sleep, calls } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ comments: [comment(1), comment(2)] }));

  const result = await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    after: 0,
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(result, [comment(1), comment(2)]);
  assertEquals(calls, []); // never had to wait
});

Deno.test("runLongPoll keeps polling (sleeping between empty polls) until a match shows up", async () => {
  const { sleep, calls } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    const comments = call < 3 ? [comment(1)] : [comment(1), comment(2)];
    return Promise.resolve(jsonResponse({ comments }));
  };

  const result = await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    after: 1,
    intervalMs: 5_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(result, [comment(2)]);
  assertEquals(calls, [5_000, 5_000]);
});

Deno.test("runLongPoll gives up empty-handed once shouldStop says so (test-only escape hatch)", async () => {
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ comments: [] }));

  const result = await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    after: 0,
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
    shouldStop: stopAfter(3),
  });

  assertEquals(result, []);
});

Deno.test("runLongPoll logs a transient (5xx) failure to stderr and keeps polling", async () => {
  const stderr: string[] = [];
  const { sleep } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    if (call === 1) return Promise.resolve(jsonResponse({ error: "boom" }, 500));
    return Promise.resolve(jsonResponse({ comments: [comment(1)] }));
  };

  const result = await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    after: 0,
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: (t) => stderr.push(t),
    sleep,
  });

  assertEquals(result, [comment(1)]);
  assertEquals(stderr.length, 1);
});

Deno.test("runLongPoll rethrows a fatal (401) failure instead of looping forever", async () => {
  const { sleep } = collectingSleep();
  const fetchFn = () => Promise.resolve(jsonResponse({ error: "token has expired" }, 401));

  await assertRejects(
    () =>
      runLongPoll({
        baseUrl: "https://claw.example.com",
        jwt: "expired.jwt",
        issue: 24,
        after: 0,
        intervalMs: 10_000,
        fetch: fetchFn,
        stderr: () => {},
        sleep,
      }),
    Error,
    "token has expired",
  );
});

Deno.test("runLongPoll forwards the authors filter to each poll", async () => {
  const seenAuthors: (string | null)[] = [];
  const { sleep } = collectingSleep();
  const fetchFn = (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    seenAuthors.push(url.searchParams.get("authors"));
    return Promise.resolve(jsonResponse({ comments: [comment(1)] }));
  };

  await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    authors: ["dtinth", "alice"],
    after: 0,
    intervalMs: 10_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(seenAuthors, ["dtinth,alice"]);
});

Deno.test("runLongPoll's --before also bounds which comments count as a match", async () => {
  const { sleep } = collectingSleep();
  let call = 0;
  const fetchFn = () => {
    call++;
    // First poll only has a too-new comment (filtered out by --before);
    // second poll has one inside the [after, before) range.
    const comments = call === 1
      ? [comment(1), comment(50)]
      : [comment(1), comment(20), comment(50)];
    return Promise.resolve(jsonResponse({ comments }));
  };

  const result = await runLongPoll({
    baseUrl: "https://claw.example.com",
    jwt: "the.jwt",
    issue: 24,
    after: 1,
    before: 30,
    intervalMs: 5_000,
    fetch: fetchFn,
    stderr: () => {},
    sleep,
  });

  assertEquals(result, [comment(20)]);
});
