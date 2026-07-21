/**
 * Client for `POST /api/upload` — lets an agent attach a file (screenshot,
 * log, build artifact) to a public, IPFS-addressed URL it can drop into a
 * GitHub comment. Like `comments_client.ts`, this authenticates with the
 * claw JWT itself (verified server-side), not a minted installation token.
 */

export interface UploadResult {
  url: string;
  cid: string;
}

/** Thrown when an upload request fails. `status` is absent for network-level failures. */
export class UploadClientError extends Error {
  override name = "UploadClientError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface UploadClientDeps {
  /** claw server base URL, e.g. `https://claw.example.com`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

export interface UploadParams {
  /** The claw JWT, sent as-is as the bearer token. */
  jwt: string;
  data: Uint8Array;
  filename: string;
}

export interface UploadClient {
  upload(params: UploadParams): Promise<UploadResult>;
}

export function createUploadClient(deps: UploadClientDeps): UploadClient {
  const fetchFn = deps.fetch ?? fetch;
  const base = deps.baseUrl.replace(/\/$/, "");

  return {
    async upload({ jwt, data, filename }) {
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(data)]), filename);

      let response: Response;
      try {
        response = await fetchFn(`${base}/api/upload`, {
          method: "POST",
          headers: { authorization: `Bearer ${jwt}` },
          body: form,
        });
      } catch (error) {
        throw new UploadClientError(
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
        throw new UploadClientError(message, response.status);
      }

      const parsed = body as { url?: unknown; cid?: unknown };
      if (typeof parsed.url !== "string" || typeof parsed.cid !== "string") {
        throw new UploadClientError("unexpected response from /api/upload", response.status);
      }
      return { url: parsed.url, cid: parsed.cid };
    },
  };
}
