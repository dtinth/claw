/**
 * Core of `claw read` and `claw long-poll`: fetch `/api/comments` for one
 * issue, optionally bounded to a `commentId` range, and — for `long-poll` —
 * keep retrying until that range has at least one match.
 *
 * This replaces `claw monitor`. That command needed a wrapper like the
 * Monitor tool to run as an unbounded background watch, but Claude Code caps
 * a Monitor task's lifetime at 30 minutes and other agents (e.g. OpenCode)
 * have no equivalent tool at all. `long-poll` instead blocks *inside one
 * foreground command* until a new comment shows up, then exits — no
 * background-watch primitive required from the host agent, and no lifetime
 * cap to work around. `read` is the non-waiting half: fetch once, print
 * whatever currently matches, exit immediately — used to find the id to
 * pass as `long-poll`'s `--after`.
 */
import {
  CommentsClientError,
  createCommentsClient,
  type RelayedComment,
} from "./comments_client.ts";

export interface FilterBounds {
  /** Keep only comments with a strictly greater `commentId`. */
  after?: number;
  /** Keep only comments with a strictly smaller `commentId`. */
  before?: number;
}

/** Pure: keep only comments within the given `commentId` bounds (either, both, or neither). */
export function filterComments(
  comments: RelayedComment[],
  bounds: FilterBounds,
): RelayedComment[] {
  return comments.filter((c) =>
    (bounds.after === undefined || c.commentId > bounds.after) &&
    (bounds.before === undefined || c.commentId < bounds.before)
  );
}

export interface LongPollCommandArgs {
  issue: number;
  repo?: string;
  authors?: string[];
  before?: number;
  intervalSeconds?: number;
  timeoutSeconds?: number;
}

/**
 * Rebuilds the exact `claw long-poll` invocation to run next — same flags as
 * this run, `--after` advanced to `afterId`. Printed back to the caller so
 * restarting the watch is "run the line you were just given," not "remember
 * to bump `--after` yourself" (see https://github.com/dtinth/gangprompting-skill/pull/8,
 * whose `long-poll` does the same thing for the same reason).
 */
export function formatLongPollCommand(args: LongPollCommandArgs, afterId: number): string {
  const parts = ["claw", "long-poll", String(args.issue)];
  if (args.repo !== undefined) parts.push("--repo", args.repo);
  if (args.authors !== undefined) parts.push("--authors", args.authors.join(","));
  if (args.before !== undefined) parts.push("--before", String(args.before));
  if (args.intervalSeconds !== undefined) parts.push("--interval", String(args.intervalSeconds));
  if (args.timeoutSeconds !== undefined) parts.push("--timeout", String(args.timeoutSeconds));
  parts.push("--after", String(afterId));
  return parts.join(" ");
}

export interface RunLongPollParams extends FilterBounds {
  baseUrl: string;
  /** The claw JWT for this repo — sent directly, no installation token is minted. */
  jwt: string;
  issue: number;
  authors?: string[];
  intervalMs: number;
  /**
   * Give up (returning no comments) once this many milliseconds have
   * elapsed, rather than waiting forever — for a harness that can't run a
   * background command indefinitely. Undefined (the default) never gives up.
   */
  timeoutMs?: number;
  fetch?: typeof fetch;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Wall clock, for `timeoutMs`. Defaults to `Date.now`; only tests override it. */
  now?: () => number;
  /** Returns true to give up empty-handed. Defaults to never giving up; only tests bound iterations. */
  shouldStop?: () => boolean;
}

/**
 * Poll until at least one comment matches the given bounds, then return the
 * matches — or, if `timeoutMs` elapses first, return an empty array. A 4xx
 * response (bad/expired JWT, relay disabled) is treated as fatal and
 * rethrown — retrying can't fix it. Anything else (5xx, network errors) is
 * logged to stderr and the loop keeps polling.
 */
export async function runLongPoll(params: RunLongPollParams): Promise<RelayedComment[]> {
  const client = createCommentsClient({
    baseUrl: params.baseUrl,
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  const bounds: FilterBounds = {
    ...(params.after !== undefined ? { after: params.after } : {}),
    ...(params.before !== undefined ? { before: params.before } : {}),
  };
  const now = params.now ?? Date.now;
  const deadline = params.timeoutMs !== undefined ? now() + params.timeoutMs : undefined;

  while (!(params.shouldStop?.() ?? false)) {
    try {
      const comments = await client.fetchComments({
        jwt: params.jwt,
        issue: params.issue,
        ...(params.authors ? { authors: params.authors } : {}),
      });
      const matched = filterComments(comments, bounds);
      if (matched.length > 0) return matched;
    } catch (error) {
      const fatal = error instanceof CommentsClientError && error.status !== undefined &&
        error.status < 500;
      if (fatal) {
        params.stderr(
          `claw long-poll: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
      params.stderr(
        `claw long-poll: poll failed, retrying: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    if (deadline !== undefined && now() >= deadline) return [];
    await params.sleep(params.intervalMs);
  }
  return [];
}
