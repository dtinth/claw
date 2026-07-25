/**
 * `claw usage-report`'s core loop: on each tick, read the local Claude Code
 * OAuth token, ask Anthropic for the real 5-hour/weekly rate-limit usage,
 * and submit it to claw under whichever grant expires furthest out (the
 * usage meter isn't tied to a specific repo, so any valid grant works).
 *
 * Mirrors `monitor.ts`'s shape: real filesystem reads happen directly
 * (grants file, credentials file — same exception the rest of this CLI
 * makes), network calls go through injectable `fetch`, and a transient
 * failure is logged and retried rather than ending the process.
 */
import { createAnthropicUsageClient } from "./anthropic_usage_client.ts";
import { readClaudeAccessToken } from "./claude_credentials.ts";
import { loadGrants, pickFurthestExpiringGrant } from "./grants.ts";
import { createUsageReportClient } from "./usage_report_client.ts";

export interface RunUsageReportLoopParams {
  intervalMs: number;
  /** Directory containing `grants.json`. */
  configDir: string;
  /** Path to Claude Code's `.credentials.json`. */
  credentialsPath: string;
  baseUrl: string;
  fetch?: typeof fetch;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Returns true to stop the loop. Defaults to never stopping; only tests bound iterations. */
  shouldStop?: () => boolean;
}

/**
 * `String(x)` on a plain thrown object (not an Error) stringifies to the
 * useless "[object Object]" — fall back to JSON.stringify for anything
 * that isn't already an Error, so an unforeseen non-Error rejection still
 * surfaces something legible.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function runUsageReportLoop(params: RunUsageReportLoopParams): Promise<void> {
  const usageClient = createAnthropicUsageClient({
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  const reportClient = createUsageReportClient({
    baseUrl: params.baseUrl,
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });

  while (!(params.shouldStop?.() ?? false)) {
    try {
      const grants = await loadGrants(`${params.configDir}/grants.json`);
      const jwt = pickFurthestExpiringGrant(grants);
      const accessToken = await readClaudeAccessToken(params.credentialsPath);
      const usage = await usageClient.fetchUsage(accessToken);
      await reportClient.submit(jwt, usage);
      params.stderr(
        `claw usage-report: ok — 5h ${usage.fiveHourPct}%, 7d ${usage.weeklyPct}%\n`,
      );
    } catch (error) {
      params.stderr(`claw usage-report: poll failed, retrying: ${describeError(error)}\n`);
    }
    await params.sleep(params.intervalMs);
  }
}
