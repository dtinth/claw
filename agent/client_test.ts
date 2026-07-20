import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createTokenClient, TokenClientError } from "./client.ts";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
}

function fakeFetch(handler: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const recorded: Recorded = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: new Headers(init?.headers),
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

Deno.test("mint posts the JWT as a bearer token to /api/token", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({
      token: "ghs_minted",
      expires_at: "2026-07-21T01:00:00Z",
      repository: "dtinth/claw",
      permissions: { contents: "write" },
    })
  );
  const client = createTokenClient({ baseUrl: "https://claw.example.com", fetch: fn });

  const result = await client.mint("the.claw.jwt");

  assertEquals(result, {
    token: "ghs_minted",
    expiresAt: "2026-07-21T01:00:00Z",
    repository: "dtinth/claw",
    permissions: { contents: "write" },
  });
  assertEquals(calls[0]!.url, "https://claw.example.com/api/token");
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer the.claw.jwt");
});

Deno.test("mint strips a trailing slash from the base URL", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({ token: "t", expires_at: "e", repository: "r", permissions: {} })
  );
  const client = createTokenClient({ baseUrl: "https://claw.example.com/", fetch: fn });
  await client.mint("jwt");
  assertEquals(calls[0]!.url, "https://claw.example.com/api/token");
});

Deno.test("mint surfaces the server's error message on rejection", async () => {
  const { fn } = fakeFetch(() => json({ error: "token has expired" }, 401));
  const client = createTokenClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await assertRejects(
    () => client.mint("expired.jwt"),
    TokenClientError,
    "token has expired",
  );
});

Deno.test("mint falls back to the HTTP status when the body has no error field", async () => {
  const { fn } = fakeFetch(() => new Response("", { status: 500 }));
  const client = createTokenClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await assertRejects(
    () => client.mint("jwt"),
    TokenClientError,
    "500",
  );
});

Deno.test("mint throws when the success body is missing required fields", async () => {
  const { fn } = fakeFetch(() => json({ token: "ghs_x" }));
  const client = createTokenClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(() => client.mint("jwt"), TokenClientError);
  assertStringIncludes(error.message, "unexpected");
});
