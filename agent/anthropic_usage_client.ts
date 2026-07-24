/**
 * Client for Anthropic's `/api/oauth/usage` endpoint — a free `GET` (no
 * completion, no token cost) that returns the same 5-hour/7-day rate-limit
 * percentages Claude Code itself is throttled by. Authenticates with
 * Claude Code's own OAuth access token (see `claude_credentials.ts`), never
 * claw's own credentials.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export interface AnthropicUsage {
  fiveHourPct: number;
  fiveHourResetsAt: string;
  weeklyPct: number;
  weeklyResetsAt: string;
  /** Only present when the response's `extra_usage` block is enabled. */
  extraUsageEnabled?: boolean;
  extraUsagePct?: number;
}

/** Thrown when the usage request fails. `status` is absent for network-level failures. */
export class AnthropicUsageError extends Error {
  override name = "AnthropicUsageError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface AnthropicUsageClientDeps {
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

export interface AnthropicUsageClient {
  fetchUsage(accessToken: string): Promise<AnthropicUsage>;
}

export function createAnthropicUsageClient(
  deps: AnthropicUsageClientDeps = {},
): AnthropicUsageClient {
  const fetchFn = deps.fetch ?? fetch;

  return {
    async fetchUsage(accessToken) {
      let response: Response;
      try {
        response = await fetchFn(USAGE_URL, {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            accept: "application/json",
          },
        });
      } catch (error) {
        throw new AnthropicUsageError(
          `could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${response.status}`;
        throw new AnthropicUsageError(message, response.status);
      }

      const b = body as {
        five_hour?: { utilization?: unknown; resets_at?: unknown };
        seven_day?: { utilization?: unknown; resets_at?: unknown };
        extra_usage?: { is_enabled?: unknown; utilization?: unknown };
      } | undefined;

      const fiveHourPct = b?.five_hour?.utilization;
      const fiveHourResetsAt = b?.five_hour?.resets_at;
      const weeklyPct = b?.seven_day?.utilization;
      const weeklyResetsAt = b?.seven_day?.resets_at;
      if (
        typeof fiveHourPct !== "number" || typeof fiveHourResetsAt !== "string" ||
        typeof weeklyPct !== "number" || typeof weeklyResetsAt !== "string"
      ) {
        throw new AnthropicUsageError(
          "unexpected response from Anthropic's usage endpoint",
          response.status,
        );
      }

      const usage: AnthropicUsage = { fiveHourPct, fiveHourResetsAt, weeklyPct, weeklyResetsAt };
      const extra = b?.extra_usage;
      if (extra?.is_enabled === true) {
        usage.extraUsageEnabled = true;
        if (typeof extra.utilization === "number") usage.extraUsagePct = extra.utilization;
      }
      return usage;
    },
  };
}
