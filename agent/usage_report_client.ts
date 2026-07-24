/**
 * Client for `POST /api/usage-report` — submits a Claude usage snapshot
 * (from `anthropic_usage_client.ts`) to claw. Like `comments_client.ts`,
 * this authenticates with the claw JWT itself, not a minted installation
 * token: any valid grant works, since the usage meter isn't tied to a repo.
 */
import type { AnthropicUsage } from "./anthropic_usage_client.ts";

/** Thrown when a usage-report request fails. `status` is absent for network-level failures. */
export class UsageReportClientError extends Error {
  override name = "UsageReportClientError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface UsageReportClientDeps {
  /** claw server base URL, e.g. `https://claw.example.com`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

export interface UsageReportClient {
  submit(jwt: string, usage: AnthropicUsage): Promise<void>;
}

export function createUsageReportClient(deps: UsageReportClientDeps): UsageReportClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");

  return {
    async submit(jwt, usage) {
      const body: Record<string, unknown> = {
        fiveHourPct: usage.fiveHourPct,
        fiveHourResetsAt: usage.fiveHourResetsAt,
        weeklyPct: usage.weeklyPct,
        weeklyResetsAt: usage.weeklyResetsAt,
      };
      if (usage.extraUsageEnabled !== undefined || usage.extraUsagePct !== undefined) {
        body.extraUsage = {
          enabled: usage.extraUsageEnabled ?? false,
          pct: usage.extraUsagePct ?? 0,
        };
      }

      let response: Response;
      try {
        response = await fetchFn(`${base}/api/usage-report`, {
          method: "POST",
          headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new UsageReportClientError(
          `could not reach the claw server: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          if (data && typeof data === "object" && typeof data.error === "string") {
            message = data.error;
          }
        } catch {
          // keep the HTTP-status fallback
        }
        throw new UsageReportClientError(message, response.status);
      }
    },
  };
}
