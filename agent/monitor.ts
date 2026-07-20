/**
 * `claw monitor`'s core: poll `/api/comments` for one issue, emit each newly
 * arrived comment as a single JSON line on stdout, and keep looping. Built to
 * run under the Monitor tool's "unbounded command, one stdout line per
 * event" contract — status/error output must stay on stderr, and a
 * transient failure must never end the process, since a dead process is a
 * silently ended watch.
 *
 * Stateless by design: the high-water-mark lives only in memory for the
 * life of the process. Restarting re-emits the current backlog rather than
 * resuming — no cursor file, nothing written to disk.
 */
import {
  CommentsClientError,
  createCommentsClient,
  type RelayedComment,
} from "./comments_client.ts";

export interface DiffResult {
  newComments: RelayedComment[];
  nextCursor: number | null;
}

/**
 * Pure: split `comments` into what's new relative to `lastSeen`, and what
 * the cursor should advance to. `lastSeen: null` means "first-ever poll" —
 * everything currently there counts as new. The cursor never regresses
 * below its prior value, and an empty fetch leaves it untouched.
 */
export function diffNewComments(
  comments: RelayedComment[],
  lastSeen: number | null,
): DiffResult {
  if (comments.length === 0) {
    return { newComments: [], nextCursor: lastSeen };
  }
  const newComments = lastSeen === null ? comments : comments.filter((c) => c.commentId > lastSeen);
  const nextCursor = comments.reduce(
    (max, c) => Math.max(max, c.commentId),
    lastSeen ?? comments[0]!.commentId,
  );
  return { newComments, nextCursor };
}

export interface RunMonitorLoopParams {
  baseUrl: string;
  /** The claw JWT for this repo — sent directly, no installation token is minted. */
  jwt: string;
  issue: number;
  authors?: string[];
  intervalMs: number;
  fetch?: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Returns true to stop the loop. Defaults to never stopping; only tests bound iterations. */
  shouldStop?: () => boolean;
}

/**
 * Poll forever (until `shouldStop` says otherwise), emitting new comments as
 * jsonl. A 4xx response (bad/expired JWT, relay disabled) is treated as
 * fatal and rethrown — retrying can't fix it, and exiting is the correct
 * signal. Anything else (5xx, network errors) is logged to stderr and the
 * loop continues.
 */
export async function runMonitorLoop(params: RunMonitorLoopParams): Promise<void> {
  const client = createCommentsClient({
    baseUrl: params.baseUrl,
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  let lastSeen: number | null = null;

  while (!(params.shouldStop?.() ?? false)) {
    try {
      const comments = await client.fetchComments({
        jwt: params.jwt,
        issue: params.issue,
        ...(params.authors ? { authors: params.authors } : {}),
      });
      const { newComments, nextCursor } = diffNewComments(comments, lastSeen);
      for (const comment of newComments) {
        params.stdout(JSON.stringify(comment) + "\n");
      }
      lastSeen = nextCursor;
    } catch (error) {
      const fatal = error instanceof CommentsClientError && error.status !== undefined &&
        error.status < 500;
      if (fatal) {
        params.stderr(
          `claw monitor: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        throw error;
      }
      params.stderr(
        `claw monitor: poll failed, retrying: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    await params.sleep(params.intervalMs);
  }
}
