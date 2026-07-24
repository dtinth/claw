import { assertEquals, assertRejects } from "@std/assert";
import { AnthropicUsageError, createAnthropicUsageClient } from "./anthropic_usage_client.ts";

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

const SAMPLE_BODY = {
  five_hour: { utilization: 68, resets_at: "2026-07-24T18:30:00Z" },
  seven_day: { utilization: 31, resets_at: "2026-07-28T00:00:00Z" },
  extra_usage: { is_enabled: false, utilization: null, used_credits: null, monthly_limit: null },
};

Deno.test("fetchUsage requests the oauth/usage endpoint with the bearer token and required headers", async () => {
  const { fn, calls } = fakeFetch(() => json(SAMPLE_BODY));
  const client = createAnthropicUsageClient({ fetch: fn });

  const usage = await client.fetchUsage("sk-ant-oat-fake");

  assertEquals(calls[0]!.url, "https://api.anthropic.com/api/oauth/usage");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer sk-ant-oat-fake");
  assertEquals(calls[0]!.headers.get("anthropic-beta"), "oauth-2025-04-20");
  assertEquals(usage, {
    fiveHourPct: 68,
    fiveHourResetsAt: "2026-07-24T18:30:00Z",
    weeklyPct: 31,
    weeklyResetsAt: "2026-07-28T00:00:00Z",
  });
});

Deno.test("fetchUsage includes extra usage fields when enabled", async () => {
  const { fn } = fakeFetch(() =>
    json({
      ...SAMPLE_BODY,
      extra_usage: { is_enabled: true, utilization: 12, used_credits: 5, monthly_limit: 100 },
    })
  );
  const client = createAnthropicUsageClient({ fetch: fn });
  const usage = await client.fetchUsage("token");
  assertEquals(usage.extraUsageEnabled, true);
  assertEquals(usage.extraUsagePct, 12);
});

Deno.test("fetchUsage omits extra usage fields when the block is absent", async () => {
  const { fn } = fakeFetch(() =>
    json({
      five_hour: SAMPLE_BODY.five_hour,
      seven_day: SAMPLE_BODY.seven_day,
    })
  );
  const client = createAnthropicUsageClient({ fetch: fn });
  const usage = await client.fetchUsage("token");
  assertEquals("extraUsageEnabled" in usage, false);
  assertEquals("extraUsagePct" in usage, false);
});

Deno.test("fetchUsage throws AnthropicUsageError with the status on a 401", async () => {
  const { fn } = fakeFetch(() => json({ error: "invalid token" }, 401));
  const client = createAnthropicUsageClient({ fetch: fn });
  const error = await assertRejects(
    () => client.fetchUsage("expired"),
    AnthropicUsageError,
  );
  assertEquals(error.status, 401);
});

Deno.test("fetchUsage throws AnthropicUsageError when the response shape is unexpected", async () => {
  const { fn } = fakeFetch(() => json({ nope: true }));
  const client = createAnthropicUsageClient({ fetch: fn });
  await assertRejects(() => client.fetchUsage("token"), AnthropicUsageError, "unexpected");
});

Deno.test("fetchUsage throws a status-less AnthropicUsageError on a network failure", async () => {
  const fn = (): Promise<Response> => {
    throw new TypeError("network error");
  };
  const client = createAnthropicUsageClient({ fetch: fn });
  const error = await assertRejects(() => client.fetchUsage("token"), AnthropicUsageError);
  assertEquals(error.status, undefined);
});
