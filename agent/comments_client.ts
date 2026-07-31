/**
 * Client for `GET /api/comments` — the comment relay an agent polls to see
 * GitHub replies without watching GitHub directly. Unlike `client.ts`, this
 * authenticates with the claw JWT itself (verified server-side, no GitHub
 * call): the server's `verifyClawJwt` accepts it directly, so there is no
 * installation token to mint here.
 */

/** A comment relayed from a GitHub webhook, as returned by the server. */
export interface RelayedComment {
  commentId: number;
  repo: string;
  issue: number;
  author: string;
  authorId: number;
  body: string;
  url: string;
}

/** Thrown when a comments-poll request fails. `status` is absent for network-level failures. */
export class CommentsClientError extends Error {
  override name = "CommentsClientError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * A stalled connection (dead proxy, half-open TCP) leaves `fetch` pending
 * forever — no error, no timeout by default — which for `monitor`'s
 * infinite poll loop means the process sits alive but silently stops
 * emitting comments. Bound every request so it fails and gets retried.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface CommentsClientDeps {
  /** claw server base URL, e.g. `https://claw.example.com`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
  /** Per-request timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface FetchCommentsParams {
  /** The claw JWT, sent as-is as the bearer token. */
  jwt: string;
  issue: number;
  authors?: string[];
}

export interface CommentsClient {
  fetchComments(params: FetchCommentsParams): Promise<RelayedComment[]>;
}

export function createCommentsClient(deps: CommentsClientDeps): CommentsClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetchComments({ jwt, issue, authors }) {
      const url = new URL(`${base}/api/comments`);
      url.searchParams.set("issue", String(issue));
      if (authors && authors.length > 0) url.searchParams.set("authors", authors.join(","));

      let response: Response;
      try {
        response = await fetchFn(url.toString(), {
          headers: { authorization: `Bearer ${jwt}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new CommentsClientError(
          `could not reach the claw server: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const message = body && typeof body === "object" && "error" in body &&
            typeof (body as { error: unknown }).error === "string"
          ? (body as { error: string }).error
          : `HTTP ${response.status}`;
        throw new CommentsClientError(message, response.status);
      }

      const data = body as { comments?: unknown };
      if (!Array.isArray(data.comments)) {
        throw new CommentsClientError("unexpected response from /api/comments", response.status);
      }
      return data.comments as RelayedComment[];
    },
  };
}
