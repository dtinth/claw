import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createGristClient, GristApiError } from "./client.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fakeFetch(handler: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const rec: Recorded = { url, method, headers, body };
    calls.push(rec);
    return Promise.resolve(handler(rec));
  };
  return { fn, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEPS = {
  apiUrl: "https://grist.example.com/api/docs/abc123",
  apiKey: "gristkey",
  table: "Comments",
};

Deno.test("upsertComment PUTs an add-or-update keyed by Comment_ID", async () => {
  const { fn, calls } = fakeFetch(() => json({ records: [{ id: 1 }] }));
  const client = createGristClient({ ...DEPS, fetch: fn });

  await client.upsertComment({
    Comment_ID: 5015219517,
    Repo: "bemusic/bemuse",
    Issue: 844,
    User_ID: 193136,
    User_Name: "dtinth",
    Body: "Is the bridge working?",
  });

  const call = calls[0]!;
  assertEquals(call.method, "PUT");
  assertEquals(call.url, "https://grist.example.com/api/docs/abc123/tables/Comments/records");
  assertEquals(call.headers.get("authorization"), "Bearer gristkey");
  const body = call.body as { records: Array<{ require: unknown; fields: unknown }> };
  assertEquals(body.records[0]!.require, { Comment_ID: 5015219517 });
  assertEquals(body.records[0]!.fields, {
    Repo: "bemusic/bemuse",
    Issue: 844,
    User_ID: 193136,
    User_Name: "dtinth",
    Body: "Is the bridge working?",
  });
});

Deno.test("queryComments filters by repo and maps records", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({
      records: [{
        id: 4,
        fields: {
          Comment_ID: 5015219517,
          Issue: 844,
          Repo: "bemusic/bemuse",
          Body: "Is the bridge working?",
          User_ID: 193136,
          User_Name: "dtinth",
        },
      }],
    })
  );
  const client = createGristClient({ ...DEPS, fetch: fn });

  const comments = await client.queryComments({ repo: "bemusic/bemuse" });
  assertEquals(comments, [{
    commentId: 5015219517,
    repo: "bemusic/bemuse",
    issue: 844,
    author: "dtinth",
    authorId: 193136,
    body: "Is the bridge working?",
    url: "https://github.com/bemusic/bemuse/issues/844#issuecomment-5015219517",
  }]);

  const filter = new URL(calls[0]!.url).searchParams.get("filter")!;
  assertEquals(JSON.parse(filter), { Repo: ["bemusic/bemuse"] });
});

Deno.test("queryComments adds issue and author filters when provided", async () => {
  const { fn, calls } = fakeFetch(() => json({ records: [] }));
  const client = createGristClient({ ...DEPS, fetch: fn });

  await client.queryComments({ repo: "o/r", issue: 42, authors: ["dtinth", "alice"] });

  const filter = JSON.parse(new URL(calls[0]!.url).searchParams.get("filter")!);
  assertEquals(filter, { Repo: ["o/r"], Issue: [42], User_Name: ["dtinth", "alice"] });
});

Deno.test("upsertComment throws GristApiError on a failure response", async () => {
  const { fn } = fakeFetch(() => json({ error: "nope" }, 403));
  const client = createGristClient({ ...DEPS, fetch: fn });
  await assertRejects(
    () =>
      client.upsertComment({
        Comment_ID: 1,
        Repo: "o/r",
        Issue: 1,
        User_ID: 1,
        User_Name: "a",
        Body: "b",
      }),
    GristApiError,
    "403",
  );
});

Deno.test("queryComments throws GristApiError on a failure response", async () => {
  const { fn } = fakeFetch(() => new Response("boom", { status: 500 }));
  const client = createGristClient({ ...DEPS, fetch: fn });
  const error = await assertRejects(
    () => client.queryComments({ repo: "o/r" }),
    GristApiError,
  );
  assertStringIncludes(String(error), "500");
});
