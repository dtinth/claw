/**
 * The CLI's one call to the claw server: exchange a claw JWT for a
 * repo-scoped GitHub installation token via `POST /api/token`.
 * `fetch` is injectable so this is tested without touching the network.
 */

/** A repository-scoped installation token, as minted by the server. */
export interface MintedToken {
  token: string;
  /** ISO-8601 expiry (GitHub installation tokens last ~1 hour). */
  expiresAt: string;
  repository: string;
  permissions: Record<string, string>;
}

/** Thrown when the token exchange fails. */
export class TokenClientError extends Error {
  override name = "TokenClientError";
}

export interface TokenClientDeps {
  /** claw server base URL, e.g. `https://claw.example.com`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

export interface TokenClient {
  /** Exchange a claw JWT for a repo-scoped installation token. */
  mint(jwt: string): Promise<MintedToken>;
}

export function createTokenClient(deps: TokenClientDeps): TokenClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");

  return {
    async mint(jwt) {
      const response = await fetchFn(`${base}/api/token`, {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });

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
        throw new TokenClientError(`token exchange failed: ${message}`);
      }

      const data = body as {
        token?: string;
        expires_at?: string;
        repository?: string;
        permissions?: Record<string, string>;
      };
      if (!data.token || !data.expires_at || !data.repository) {
        throw new TokenClientError("token exchange returned an unexpected response");
      }
      return {
        token: data.token,
        expiresAt: data.expires_at,
        repository: data.repository,
        permissions: data.permissions ?? {},
      };
    },
  };
}
