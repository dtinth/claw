/**
 * Core of `claw await-grant`: poll `/api/grant-requests/poll` with the secret
 * `claw request-grant` printed, until the human approves it (or `--timeout`
 * gives up) — mirrors `read.ts`'s `runLongPoll` shape on purpose, so this
 * CLI's two polling loops behave the same way.
 */
import { createGrantRequestClient, GrantRequestClientError } from "./grant_request_client.ts";

export interface RunAwaitGrantParams {
  baseUrl: string;
  secret: string;
  intervalMs: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  shouldStop?: () => boolean;
}

export type AwaitGrantResult =
  | { status: "approved"; token: string; expiresAt: string }
  | { status: "timed_out" };

export async function runAwaitGrant(params: RunAwaitGrantParams): Promise<AwaitGrantResult> {
  const client = createGrantRequestClient({
    baseUrl: params.baseUrl,
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  const now = params.now ?? Date.now;
  const deadline = params.timeoutMs !== undefined ? now() + params.timeoutMs : undefined;

  while (!(params.shouldStop?.() ?? false)) {
    try {
      const result = await client.poll(params.secret);
      if (result.status === "approved") return result;
    } catch (error) {
      // A 4xx (e.g. 404: expired, unknown, or already-claimed secret) can
      // never resolve by retrying — unlike a transient 5xx, which can.
      const fatal = error instanceof GrantRequestClientError && error.status !== undefined &&
        error.status < 500;
      if (fatal) {
        params.stderr(
          `claw await-grant: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
      params.stderr(
        `claw await-grant: poll failed, retrying: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    if (deadline !== undefined && now() >= deadline) return { status: "timed_out" };
    await params.sleep(params.intervalMs);
  }
  return { status: "timed_out" };
}
