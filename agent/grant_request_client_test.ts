import { assertEquals, assertRejects } from "@std/assert";
import { createGrantRequestClient, GrantRequestClientError } from "./grant_request_client.ts";

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
    const recorded: Recorded = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
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

Deno.test("create POSTs the repo (and reason, if given) and returns the secret/code/expiresInSeconds", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({ secret: "the-secret", code: "AB3K9Z", expiresInSeconds: 900 })
  );
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });

  const result = await client.create("dtinth/claw", "fixing a bug");

  assertEquals(calls[0]!.url, "https://claw.example.com/api/grant-requests");
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.body, { repo: "dtinth/claw", reason: "fixing a bug" });
  assertEquals(result, { secret: "the-secret", code: "AB3K9Z", expiresInSeconds: 900 });
});

Deno.test("create omits reason from the body when not given", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({ secret: "s", code: "AB3K9Z", expiresInSeconds: 900 })
  );
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await client.create("dtinth/claw");
  assertEquals(calls[0]!.body, { repo: "dtinth/claw" });
});

Deno.test("create throws GrantRequestClientError with the server's message on a 400", async () => {
  const { fn } = fakeFetch(() => json({ error: "not a valid repo" }, 400));
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.create("nope"),
    GrantRequestClientError,
    "not a valid repo",
  );
  assertEquals(error.status, 400);
});

Deno.test("create throws when the response shape is unexpected", async () => {
  const { fn } = fakeFetch(() => json({ nope: true }));
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await assertRejects(() => client.create("dtinth/claw"), GrantRequestClientError, "unexpected");
});

Deno.test("poll sends the secret as a bearer token and reports pending", async () => {
  const { fn, calls } = fakeFetch(() => json({ status: "pending" }));
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });

  const result = await client.poll("the-secret");

  assertEquals(calls[0]!.url, "https://claw.example.com/api/grant-requests/poll");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer the-secret");
  assertEquals(result, { status: "pending" });
});

Deno.test("poll reports approved with the token and expiry", async () => {
  const { fn } = fakeFetch(() =>
    json({ status: "approved", token: "the.claw.jwt", expiresAt: "2026-08-01T00:00:00Z" })
  );
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const result = await client.poll("the-secret");
  assertEquals(result, {
    status: "approved",
    token: "the.claw.jwt",
    expiresAt: "2026-08-01T00:00:00Z",
  });
});

Deno.test("poll throws GrantRequestClientError with the status on a 404 (expired or unknown secret)", async () => {
  const { fn } = fakeFetch(() => json({ error: "no such grant request" }, 404));
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(() => client.poll("gone"), GrantRequestClientError);
  assertEquals(error.status, 404);
});

Deno.test("poll throws a status-less GrantRequestClientError on a network failure", async () => {
  const fn = (): Promise<Response> => {
    throw new TypeError("network error");
  };
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(() => client.poll("s"), GrantRequestClientError);
  assertEquals(error.status, undefined);
});

Deno.test("create strips a trailing slash from the base URL", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({ secret: "s", code: "AB3K9Z", expiresInSeconds: 900 })
  );
  const client = createGrantRequestClient({ baseUrl: "https://claw.example.com/", fetch: fn });
  await client.create("dtinth/claw");
  assertEquals(calls[0]!.url, "https://claw.example.com/api/grant-requests");
});

Deno.test("create passes an abort signal that fires after timeoutMs", async () => {
  const fn = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("signal timed out", "TimeoutError"));
      });
    });
  const client = createGrantRequestClient({
    baseUrl: "https://claw.example.com",
    fetch: fn,
    timeoutMs: 5,
  });
  await assertRejects(() => client.create("dtinth/claw"), GrantRequestClientError);
});
