import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CommentsClientError, createCommentsClient } from "./comments_client.ts";

interface Recorded {
  url: string;
  headers: Headers;
}

function fakeFetch(handler: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const recorded: Recorded = { url, headers: new Headers(init?.headers) };
    calls.push(recorded);
    return Promise.resolve(handler(recorded));
  };
  return { fn, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE_COMMENT = {
  commentId: 111,
  repo: "dtinth/claw",
  issue: 24,
  author: "dtinth",
  authorId: 193136,
  body: "looks good",
  url: "https://github.com/dtinth/claw/issues/24#issuecomment-111",
};

Deno.test("fetchComments sends the claw JWT as a bearer token and returns comments", async () => {
  const { fn, calls } = fakeFetch(() => json({ comments: [SAMPLE_COMMENT] }));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });

  const comments = await client.fetchComments({ jwt: "the.claw.jwt", issue: 24 });

  assertEquals(comments, [SAMPLE_COMMENT]);
  assertStringIncludes(calls[0]!.url, "https://claw.example.com/api/comments");
  assertStringIncludes(calls[0]!.url, "issue=24");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer the.claw.jwt");
});

Deno.test("fetchComments forwards the authors filter", async () => {
  const { fn, calls } = fakeFetch(() => json({ comments: [] }));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await client.fetchComments({ jwt: "jwt", issue: 24, authors: ["dtinth", "alice"] });
  assertStringIncludes(calls[0]!.url, "authors=dtinth%2Calice");
});

Deno.test("fetchComments strips a trailing slash from the base URL", async () => {
  const { fn, calls } = fakeFetch(() => json({ comments: [] }));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com/", fetch: fn });
  await client.fetchComments({ jwt: "jwt", issue: 24 });
  assertStringIncludes(calls[0]!.url, "https://claw.example.com/api/comments");
});

Deno.test("fetchComments throws CommentsClientError with the status on a 401", async () => {
  const { fn } = fakeFetch(() => json({ error: "token has expired" }, 401));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.fetchComments({ jwt: "expired.jwt", issue: 24 }),
    CommentsClientError,
    "token has expired",
  );
  assertEquals(error.status, 401);
});

Deno.test("fetchComments throws CommentsClientError with the status on a 503", async () => {
  const { fn } = fakeFetch(() => json({ error: "comment relay is not configured" }, 503));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.fetchComments({ jwt: "jwt", issue: 24 }),
    CommentsClientError,
  );
  assertEquals(error.status, 503);
});

Deno.test("fetchComments falls back to the HTTP status when the body has no error field", async () => {
  const { fn } = fakeFetch(() => new Response("", { status: 500 }));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.fetchComments({ jwt: "jwt", issue: 24 }),
    CommentsClientError,
    "500",
  );
  assertEquals(error.status, 500);
});

Deno.test("fetchComments throws a status-less CommentsClientError on a network failure", async () => {
  const fn = (): Promise<Response> => {
    throw new TypeError("network error");
  };
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.fetchComments({ jwt: "jwt", issue: 24 }),
    CommentsClientError,
  );
  assertEquals(error.status, undefined);
});

Deno.test("fetchComments throws when the response shape is unexpected", async () => {
  const { fn } = fakeFetch(() => json({ notComments: [] }));
  const client = createCommentsClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await assertRejects(
    () => client.fetchComments({ jwt: "jwt", issue: 24 }),
    CommentsClientError,
    "unexpected",
  );
});
