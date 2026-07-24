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
  usageTable: "Usage",
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
    Time: 1709294400,
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
    Time: 1709294400,
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

Deno.test("queryComments includes time when the Time column is set", async () => {
  const { fn } = fakeFetch(() =>
    json({
      records: [{
        id: 4,
        fields: {
          Comment_ID: 1,
          Issue: 844,
          Repo: "bemusic/bemuse",
          Body: "hi",
          User_ID: 193136,
          User_Name: "dtinth",
          Time: 1709294400,
        },
      }],
    })
  );
  const client = createGristClient({ ...DEPS, fetch: fn });
  const comments = await client.queryComments({ repo: "bemusic/bemuse" });
  assertEquals(comments[0]!.time, 1709294400);
});

Deno.test("queryComments adds issue and author filters when provided", async () => {
  const { fn, calls } = fakeFetch(() => json({ records: [] }));
  const client = createGristClient({ ...DEPS, fetch: fn });

  await client.queryComments({ repo: "o/r", issue: 42, authors: ["dtinth", "alice"] });

  const filter = JSON.parse(new URL(calls[0]!.url).searchParams.get("filter")!);
  assertEquals(filter, { Repo: ["o/r"], Issue: [42], User_Name: ["dtinth", "alice"] });
});

Deno.test("listActivity filters by authors, sorts by -Time, and applies the limit", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({
      records: [{
        id: 1,
        fields: {
          Comment_ID: 9,
          Repo: "dtinth/claw",
          Issue: 5,
          Body: "hi",
          User_ID: 1,
          User_Name: "dtinth-claw[bot]",
          Time: 1719800000,
        },
      }],
    })
  );
  const client = createGristClient({ ...DEPS, fetch: fn });

  const comments = await client.listActivity({
    authors: ["dtinth-claw[bot]", "dtinth"],
    limit: 20,
  });

  assertEquals(comments, [{
    commentId: 9,
    repo: "dtinth/claw",
    issue: 5,
    author: "dtinth-claw[bot]",
    authorId: 1,
    body: "hi",
    time: 1719800000,
    url: "https://github.com/dtinth/claw/issues/5#issuecomment-9",
  }]);

  const url = new URL(calls[0]!.url);
  assertEquals(JSON.parse(url.searchParams.get("filter")!), {
    User_Name: ["dtinth-claw[bot]", "dtinth"],
  });
  assertEquals(url.searchParams.get("sort"), "-Time");
  assertEquals(url.searchParams.get("limit"), "20");
});

Deno.test("listActivity throws GristApiError on a failure response", async () => {
  const { fn } = fakeFetch(() => json({ error: "nope" }, 500));
  const client = createGristClient({ ...DEPS, fetch: fn });
  await assertRejects(
    () => client.listActivity({ authors: ["dtinth-claw[bot]"], limit: 20 }),
    GristApiError,
  );
});

const SAMPLE_SNAPSHOT = {
  updated: 1719900000,
  fiveHourPct: 68,
  fiveHourResetsAt: "2026-07-24T18:30:00Z",
  weeklyPct: 31,
  weeklyResetsAt: "2026-07-28T00:00:00Z",
};

Deno.test("upsertUsage PUTs to the usage table, keyed by the fixed Row_Kind", async () => {
  const { fn, calls } = fakeFetch(() => json({ records: [{ id: 1 }] }));
  const client = createGristClient({ ...DEPS, fetch: fn });

  await client.upsertUsage(SAMPLE_SNAPSHOT);

  const call = calls[0]!;
  assertEquals(call.method, "PUT");
  assertEquals(call.url, "https://grist.example.com/api/docs/abc123/tables/Usage/records");
  const body = call.body as { records: Array<{ require: unknown; fields: unknown }> };
  assertEquals(body.records[0]!.require, { Row_Kind: "current" });
  assertEquals(body.records[0]!.fields, {
    Row_Kind: "current",
    Updated: 1719900000,
    FiveHourPct: 68,
    FiveHourResetsAt: "2026-07-24T18:30:00Z",
    WeeklyPct: 31,
    WeeklyResetsAt: "2026-07-28T00:00:00Z",
  });
});

Deno.test("upsertUsage includes extra-usage fields only when given", async () => {
  const { fn, calls } = fakeFetch(() => json({ records: [{ id: 1 }] }));
  const client = createGristClient({ ...DEPS, fetch: fn });

  await client.upsertUsage({ ...SAMPLE_SNAPSHOT, extraUsageEnabled: true, extraUsagePct: 12 });

  const body = calls[0]!.body as { records: Array<{ fields: Record<string, unknown> }> };
  assertEquals(body.records[0]!.fields.ExtraUsageEnabled, true);
  assertEquals(body.records[0]!.fields.ExtraUsagePct, 12);
});

Deno.test("upsertUsage throws GristApiError on a failure response", async () => {
  const { fn } = fakeFetch(() => json({ error: "nope" }, 500));
  const client = createGristClient({ ...DEPS, fetch: fn });
  await assertRejects(() => client.upsertUsage(SAMPLE_SNAPSHOT), GristApiError);
});

Deno.test("getUsage returns the single current row", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({
      records: [{
        id: 1,
        fields: {
          Row_Kind: "current",
          Updated: 1719900000,
          FiveHourPct: 68,
          FiveHourResetsAt: "2026-07-24T18:30:00Z",
          WeeklyPct: 31,
          WeeklyResetsAt: "2026-07-28T00:00:00Z",
        },
      }],
    })
  );
  const client = createGristClient({ ...DEPS, fetch: fn });

  const usage = await client.getUsage();

  assertEquals(usage, SAMPLE_SNAPSHOT);
  const filter = new URL(calls[0]!.url).searchParams.get("filter")!;
  assertEquals(JSON.parse(filter), { Row_Kind: ["current"] });
});

Deno.test("getUsage returns null when there is no row yet", async () => {
  const { fn } = fakeFetch(() => json({ records: [] }));
  const client = createGristClient({ ...DEPS, fetch: fn });
  assertEquals(await client.getUsage(), null);
});

Deno.test("getUsage includes extra-usage fields when present", async () => {
  const { fn } = fakeFetch(() =>
    json({
      records: [{
        id: 1,
        fields: { ...SAMPLE_SNAPSHOT_FIELDS(), ExtraUsageEnabled: true, ExtraUsagePct: 12 },
      }],
    })
  );
  const client = createGristClient({ ...DEPS, fetch: fn });
  const usage = await client.getUsage();
  assertEquals(usage?.extraUsageEnabled, true);
  assertEquals(usage?.extraUsagePct, 12);
});

function SAMPLE_SNAPSHOT_FIELDS() {
  return {
    Row_Kind: "current",
    Updated: SAMPLE_SNAPSHOT.updated,
    FiveHourPct: SAMPLE_SNAPSHOT.fiveHourPct,
    FiveHourResetsAt: SAMPLE_SNAPSHOT.fiveHourResetsAt,
    WeeklyPct: SAMPLE_SNAPSHOT.weeklyPct,
    WeeklyResetsAt: SAMPLE_SNAPSHOT.weeklyResetsAt,
  };
}

Deno.test("getUsage throws GristApiError on a failure response", async () => {
  const { fn } = fakeFetch(() => json({ error: "nope" }, 500));
  const client = createGristClient({ ...DEPS, fetch: fn });
  await assertRejects(() => client.getUsage(), GristApiError);
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
        Time: 1709294400,
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
