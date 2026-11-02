/**
 * The in-memory store behind `claw request-grant`/`claw await-grant` — lets an
 * agent self-serve a claw JWT for a repo that has no grant yet, without you
 * having to mint one by hand. This is claw's one deliberate exception to
 * being otherwise fully stateless (see `web/app.ts`'s header comment):
 * nothing here is written to disk, and the store is capped so it can't grow
 * unbounded.
 *
 * PKCE-shaped split, driven by the request having to be postable in public
 * (e.g. a GitHub comment) without that becoming a way to steal the resulting
 * grant:
 *  - `secret` never leaves the agent's own process — the agent never shows it
 *    to a human, and `create()` only returns it to the one HTTP caller that
 *    made the request. `poll()` requires it, and is how the agent claims the
 *    eventual grant.
 *  - `code` is short and meant to be read by a human and typed into the
 *    approve page. Knowing it only lets you *look up and approve* a request
 *    (gated separately by your own session login) — never claim its grant.
 */
import { parseRepo, RepoParseError } from "./github/repo.ts";

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PENDING = 50;
const CODE_LENGTH = 6;
// Excludes visually ambiguous characters (0/O, 1/I/L).
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_REASON_LENGTH = 500;

/** The grant a successful poll resolves to — the raw claw JWT, ready to install. */
export interface IssuedGrant {
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

interface Entry {
  secret: string;
  code: string;
  repo: string;
  reason?: string;
  createdAt: number;
  status: "pending" | "approved";
  grant?: IssuedGrant;
}

/** What the approve page shows for a pending request looked up by its code. */
export interface GrantRequestSummary {
  repo: string;
  reason?: string;
}

export type PollResult =
  | { status: "pending" }
  | { status: "approved"; grant: IssuedGrant }
  | { status: "not_found" };

export class GrantRequestError extends Error {
  override name = "GrantRequestError";
}

export interface GrantRequestStoreDeps {
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `crypto.getRandomValues`. Injectable for deterministic tests. */
  randomBytes?: (length: number) => Uint8Array;
  /** How long a request stays claimable before it's pruned. Defaults to 15 minutes. */
  ttlMs?: number;
  /** Caps how many requests can be pending at once. Defaults to 50. */
  maxPending?: number;
}

export interface GrantRequestStore {
  /** @throws {GrantRequestError} for a malformed repo, an overlong reason, or a full store. */
  create(repo: string, reason?: string): { secret: string; code: string; expiresInSeconds: number };
  /** `undefined` if the code matches no live (unexpired) request. */
  lookupByCode(code: string): GrantRequestSummary | undefined;
  /** Marks the request matching `code` approved, with the grant it resolves to. False if no live request matches. */
  approve(code: string, grant: IssuedGrant): boolean;
  /**
   * The agent's side of the exchange. An `"approved"` result consumes the
   * request — it cannot be polled again — so the grant is claimed exactly once.
   */
  poll(secret: string): PollResult;
}

function randomToken(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createGrantRequestStore(deps: GrantRequestStoreDeps = {}): GrantRequestStore {
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ??
    ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const maxPending = deps.maxPending ?? DEFAULT_MAX_PENDING;

  const bySecret = new Map<string, Entry>();

  function prune(): void {
    const cutoff = now() - ttlMs;
    for (const [secret, entry] of bySecret) {
      if (entry.createdAt < cutoff) bySecret.delete(secret);
    }
  }

  function findByCode(code: string): Entry | undefined {
    for (const entry of bySecret.values()) {
      if (entry.code === code) return entry;
    }
    return undefined;
  }

  function generateCode(): string {
    let code: string;
    do {
      const bytes = randomBytes(CODE_LENGTH);
      code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
    } while (findByCode(code) !== undefined);
    return code;
  }

  return {
    create(repo, reason) {
      prune();
      try {
        parseRepo(repo);
      } catch (error) {
        throw new GrantRequestError(
          error instanceof RepoParseError ? error.message : String(error),
        );
      }
      if (reason !== undefined && reason.length > MAX_REASON_LENGTH) {
        throw new GrantRequestError(`reason must be at most ${MAX_REASON_LENGTH} characters`);
      }
      if (bySecret.size >= maxPending) {
        throw new GrantRequestError(
          "too many pending grant requests right now — try again shortly",
        );
      }

      const secret = randomToken(randomBytes(32));
      const code = generateCode();
      const entry: Entry = { secret, code, repo, createdAt: now(), status: "pending" };
      if (reason) entry.reason = reason;
      bySecret.set(secret, entry);

      return { secret, code, expiresInSeconds: Math.round(ttlMs / 1000) };
    },

    lookupByCode(code) {
      prune();
      const entry = findByCode(code);
      if (!entry) return undefined;
      const summary: GrantRequestSummary = { repo: entry.repo };
      if (entry.reason !== undefined) summary.reason = entry.reason;
      return summary;
    },

    approve(code, grant) {
      prune();
      const entry = findByCode(code);
      if (!entry) return false;
      entry.status = "approved";
      entry.grant = grant;
      return true;
    },

    poll(secret) {
      prune();
      const entry = bySecret.get(secret);
      if (!entry) return { status: "not_found" };
      if (entry.status === "pending") return { status: "pending" };
      bySecret.delete(secret);
      return { status: "approved", grant: entry.grant! };
    },
  };
}
