/**
 * Client for `claw request-grant`/`claw await-grant`'s two server endpoints —
 * self-serving a claw JWT for a repo with no grant yet, instead of you
 * minting one by hand. See `src/grant_requests.ts` for the PKCE-shaped split
 * this mirrors: `create()` hands back a `secret` that `poll()` alone uses —
 * never the human-facing `code` — so posting the code publicly (the whole
 * point of this flow) can't be used to steal the resulting grant.
 */

export interface CreateGrantRequestResult {
  secret: string;
  code: string;
  expiresInSeconds: number;
}

export type PollGrantRequestResult =
  | { status: "pending" }
  | { status: "approved"; token: string; expiresAt: string };

/** Thrown when a request-grant call fails. `status` is absent for network-level failures. */
export class GrantRequestClientError extends Error {
  override name = "GrantRequestClientError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** See {@link "./comments_client.ts"} — same rationale: bound requests so a stalled connection doesn't hang forever. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface GrantRequestClientDeps {
  /** claw server base URL, e.g. `https://claw.example.com`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
  /** Per-request timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface GrantRequestClient {
  create(repo: string, reason?: string): Promise<CreateGrantRequestResult>;
  poll(secret: string): Promise<PollGrantRequestResult>;
}

async function errorMessage(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return `HTTP ${response.status}`;
  }
  return body && typeof body === "object" && "error" in body &&
      typeof (body as { error: unknown }).error === "string"
    ? (body as { error: string }).error
    : `HTTP ${response.status}`;
}

export function createGrantRequestClient(deps: GrantRequestClientDeps): GrantRequestClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post(path: string, body: unknown): Promise<Response> {
    try {
      return await fetchFn(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GrantRequestClientError(
        `could not reach the claw server: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    async create(repo, reason) {
      const response = await post("/api/grant-requests", reason ? { repo, reason } : { repo });
      if (!response.ok) {
        throw new GrantRequestClientError(await errorMessage(response), response.status);
      }
      const data = await response.json() as Partial<CreateGrantRequestResult>;
      if (
        typeof data.secret !== "string" || typeof data.code !== "string" ||
        typeof data.expiresInSeconds !== "number"
      ) {
        throw new GrantRequestClientError(
          "unexpected response from /api/grant-requests",
          response.status,
        );
      }
      return { secret: data.secret, code: data.code, expiresInSeconds: data.expiresInSeconds };
    },

    async poll(secret) {
      let response: Response;
      try {
        response = await fetchFn(`${base}/api/grant-requests/poll`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new GrantRequestClientError(
          `could not reach the claw server: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!response.ok) {
        throw new GrantRequestClientError(await errorMessage(response), response.status);
      }
      const data = await response.json() as {
        status?: unknown;
        token?: unknown;
        expiresAt?: unknown;
      };
      if (data.status === "pending") return { status: "pending" };
      if (
        data.status === "approved" && typeof data.token === "string" &&
        typeof data.expiresAt === "string"
      ) {
        return { status: "approved", token: data.token, expiresAt: data.expiresAt };
      }
      throw new GrantRequestClientError(
        "unexpected response from /api/grant-requests/poll",
        response.status,
      );
    },
  };
}
