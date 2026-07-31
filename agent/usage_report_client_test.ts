import { assertEquals, assertRejects } from "@std/assert";
import { createUsageReportClient, UsageReportClientError } from "./usage_report_client.ts";
import type { AnthropicUsage } from "./anthropic_usage_client.ts";

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

const SAMPLE_USAGE: AnthropicUsage = {
  fiveHourPct: 68,
  fiveHourResetsAt: "2026-07-24T18:30:00Z",
  weeklyPct: 31,
  weeklyResetsAt: "2026-07-28T00:00:00Z",
};

Deno.test("submit POSTs the usage snapshot with the claw JWT as a bearer token", async () => {
  const { fn, calls } = fakeFetch(() => json({ ok: true }));
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com", fetch: fn });

  await client.submit("the.claw.jwt", SAMPLE_USAGE);

  assertEquals(calls[0]!.url, "https://claw.example.com/api/usage-report");
  assertEquals(calls[0]!.method, "POST");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer the.claw.jwt");
  assertEquals(calls[0]!.body, {
    fiveHourPct: 68,
    fiveHourResetsAt: "2026-07-24T18:30:00Z",
    weeklyPct: 31,
    weeklyResetsAt: "2026-07-28T00:00:00Z",
  });
});

Deno.test("submit includes extraUsage only when the snapshot has it", async () => {
  const { fn, calls } = fakeFetch(() => json({ ok: true }));
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com", fetch: fn });

  await client.submit("jwt", { ...SAMPLE_USAGE, extraUsageEnabled: true, extraUsagePct: 12 });

  const body = calls[0]!.body as { extraUsage?: { enabled: boolean; pct: number } };
  assertEquals(body.extraUsage, { enabled: true, pct: 12 });
});

Deno.test("submit strips a trailing slash from the base URL", async () => {
  const { fn, calls } = fakeFetch(() => json({ ok: true }));
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com/", fetch: fn });
  await client.submit("jwt", SAMPLE_USAGE);
  assertEquals(calls[0]!.url, "https://claw.example.com/api/usage-report");
});

Deno.test("submit throws UsageReportClientError with the status on a 401", async () => {
  const { fn } = fakeFetch(() => json({ error: "token has expired" }, 401));
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.submit("expired.jwt", SAMPLE_USAGE),
    UsageReportClientError,
    "token has expired",
  );
  assertEquals(error.status, 401);
});

Deno.test("submit throws UsageReportClientError with the status on a 503", async () => {
  const { fn } = fakeFetch(() => json({ error: "comment relay is not configured" }, 503));
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.submit("jwt", SAMPLE_USAGE),
    UsageReportClientError,
  );
  assertEquals(error.status, 503);
});

Deno.test("submit throws a status-less UsageReportClientError on a network failure", async () => {
  const fn = (): Promise<Response> => {
    throw new TypeError("network error");
  };
  const client = createUsageReportClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.submit("jwt", SAMPLE_USAGE),
    UsageReportClientError,
  );
  assertEquals(error.status, undefined);
});

Deno.test("submit passes an abort signal that fires after timeoutMs, so a stalled connection eventually fails instead of hanging the report loop forever", async () => {
  const fn = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("signal timed out", "TimeoutError"));
      });
    });
  const client = createUsageReportClient({
    baseUrl: "https://claw.example.com",
    fetch: fn,
    timeoutMs: 5,
  });
  await assertRejects(() => client.submit("jwt", SAMPLE_USAGE), UsageReportClientError);
});
