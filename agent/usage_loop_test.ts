import { assertEquals } from "@std/assert";
import { runUsageReportLoop } from "./usage_loop.ts";

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeClawJwt(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.not-a-real-signature`;
}

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

async function withFixtures(
  fn: (dirs: { configDir: string; credentialsPath: string }) => Promise<void>,
) {
  const configDir = await Deno.makeTempDir();
  const credsDir = await Deno.makeTempDir();
  const credentialsPath = `${credsDir}/.credentials.json`;
  try {
    await Deno.writeTextFile(
      `${configDir}/grants.json`,
      JSON.stringify({ "dtinth/claw": fakeClawJwt({ sub: "dtinth/claw", exp: 9999999999 }) }),
    );
    await Deno.writeTextFile(
      credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-fake" } }),
    );
    await fn({ configDir, credentialsPath });
  } finally {
    await Deno.remove(configDir, { recursive: true });
    await Deno.remove(credsDir, { recursive: true });
  }
}

const USAGE_BODY = {
  five_hour: { utilization: 68, resets_at: "2026-07-24T18:30:00Z" },
  seven_day: { utilization: 31, resets_at: "2026-07-28T00:00:00Z" },
};

Deno.test("runUsageReportLoop reads the credentials + furthest grant, fetches usage, and submits it", async () => {
  await withFixtures(async ({ configDir, credentialsPath }) => {
    const calls: { url: string; authHeader: string | null }[] = [];
    const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, authHeader: headers.get("authorization") });
      if (url.includes("anthropic.com")) return Promise.resolve(jsonResponse(USAGE_BODY));
      return Promise.resolve(jsonResponse({ ok: true }));
    };

    const stderr: string[] = [];
    await runUsageReportLoop({
      intervalMs: 10_000,
      configDir,
      credentialsPath,
      baseUrl: "https://claw.example.com",
      fetch: fetchFn,
      stderr: (t) => stderr.push(t),
      sleep: () => Promise.resolve(),
      shouldStop: stopAfter(1),
    });

    assertEquals(calls[0]!.url, "https://api.anthropic.com/api/oauth/usage");
    assertEquals(calls[0]!.authHeader, "Bearer sk-ant-oat-fake");
    assertEquals(calls[1]!.url, "https://claw.example.com/api/usage-report");
    assertEquals(calls[1]!.authHeader?.startsWith("Bearer "), true);
    assertEquals(stderr.some((l) => l.includes("68%")), true);
  });
});

Deno.test("runUsageReportLoop sleeps the configured interval between polls", async () => {
  await withFixtures(async ({ configDir, credentialsPath }) => {
    const sleeps: number[] = [];
    const fetchFn = () => Promise.resolve(jsonResponse(USAGE_BODY));
    await runUsageReportLoop({
      intervalMs: 12_345,
      configDir,
      credentialsPath,
      baseUrl: "https://claw.example.com",
      fetch: fetchFn,
      stderr: () => {},
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      shouldStop: stopAfter(2),
    });
    assertEquals(sleeps, [12_345, 12_345]);
  });
});

Deno.test("runUsageReportLoop logs a failure and keeps polling rather than throwing", async () => {
  await withFixtures(async ({ configDir, credentialsPath }) => {
    let call = 0;
    const fetchFn = () => {
      call++;
      if (call === 1) return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      return Promise.resolve(jsonResponse(USAGE_BODY));
    };
    const stderr: string[] = [];
    await runUsageReportLoop({
      intervalMs: 10_000,
      configDir,
      credentialsPath,
      baseUrl: "https://claw.example.com",
      fetch: fetchFn,
      stderr: (t) => stderr.push(t),
      sleep: () => Promise.resolve(),
      shouldStop: stopAfter(2),
    });
    assertEquals(stderr.some((l) => l.includes("failed")), true);
  });
});

Deno.test("runUsageReportLoop logs and keeps polling when the credentials file is missing", async () => {
  await withFixtures(async ({ configDir }) => {
    const stderr: string[] = [];
    await runUsageReportLoop({
      intervalMs: 10_000,
      configDir,
      credentialsPath: "/no/such/.credentials.json",
      baseUrl: "https://claw.example.com",
      fetch: () => Promise.resolve(jsonResponse(USAGE_BODY)),
      stderr: (t) => stderr.push(t),
      sleep: () => Promise.resolve(),
      shouldStop: stopAfter(1),
    });
    assertEquals(stderr.some((l) => l.includes("no such file")), true);
  });
});
