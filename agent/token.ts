/**
 * Get a usable GitHub token for a repo: reuse the cached one if it still has
 * more than the freshness margin left, otherwise mint a fresh one and cache
 * it.
 */
import { readCache, writeCache } from "./cache.ts";
import { createTokenClient } from "./client.ts";
import { findGrant, type GrantsStore } from "./grants.ts";
import { isFresh } from "./cache.ts";

export interface GetTokenParams {
  repo: string;
  grants: GrantsStore;
  cacheDir: string;
  baseUrl: string;
  fetch?: typeof fetch;
  now?: Date;
}

export interface RepoToken {
  token: string;
  expiresAt: string;
}

/**
 * @throws {GrantsError} when no grant is configured for `repo`.
 * @throws {TokenClientError} when the mint request fails.
 */
export async function getToken(params: GetTokenParams): Promise<RepoToken> {
  const now = params.now ?? new Date();

  const cached = await readCache(params.cacheDir, params.repo);
  if (cached && isFresh(cached, now)) {
    return cached;
  }

  const jwt = findGrant(params.grants, params.repo);
  const client = createTokenClient({
    baseUrl: params.baseUrl,
    ...(params.fetch ? { fetch: params.fetch } : {}),
  });
  const minted = await client.mint(jwt);

  const entry: RepoToken = { token: minted.token, expiresAt: minted.expiresAt };
  await writeCache(params.cacheDir, params.repo, entry);
  return entry;
}
