/**
 * Persistence for claw, backed by Deno KV.
 *
 * Two entities are stored:
 *  - **drafts** — comment drafts an agent submits for you to review and post.
 *  - **sessions** — your logged-in session, holding the GitHub user token used
 *    to post comments on your behalf. Sessions carry a TTL and expire.
 *
 * Deno KV writes to a local SQLite file by default. Mount a volume at the
 * configured path to keep drafts and sessions across redeploys; otherwise they
 * are ephemeral (you simply log in again).
 */

/** Where a drafted comment should be posted. */
export type DraftTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "discussion"; discussionNumber: number; replyToId?: string };

/** A comment an agent has drafted for you to review and post. */
export interface Draft {
  id: string;
  /** Repository as `owner/repo`. */
  repo: string;
  target: DraftTarget;
  body: string;
  status: "pending" | "posted" | "dismissed";
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** URL of the posted comment, once posted. */
  postedUrl?: string;
  /** ISO-8601 timestamp of when it was posted. */
  postedAt?: string;
}

/** Input for creating a draft (server fills id/status/createdAt). */
export interface DraftInput {
  repo: string;
  target: DraftTarget;
  body: string;
}

/** A logged-in session for the single permitted user. */
export interface Session {
  login: string;
  /** GitHub user-to-server access token. */
  accessToken: string;
  /** Refresh token, when the app issues expiring user tokens. */
  refreshToken?: string;
  /** ISO-8601 expiry of the access token, when known. */
  accessTokenExpiresAt?: string;
  createdAt: string;
}

/** claw's storage surface. */
export interface Store {
  createDraft(input: DraftInput): Promise<Draft>;
  getDraft(id: string): Promise<Draft | null>;
  listDrafts(limit?: number): Promise<Draft[]>;
  updateDraft(id: string, patch: Partial<Omit<Draft, "id">>): Promise<Draft>;
  putSession(id: string, session: Session, ttlMs: number): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  close(): void;
}

const DRAFT_PREFIX = ["draft"] as const;
const SESSION_PREFIX = ["session"] as const;

/**
 * Open a {@link Store}. Pass `":memory:"` for an ephemeral in-memory database
 * (used in tests), a filesystem path to persist, or omit for the Deno KV
 * default location.
 */
export async function openStore(path?: string): Promise<Store> {
  const kv = await Deno.openKv(path);
  return {
    async createDraft(input) {
      const draft: Draft = {
        id: crypto.randomUUID(),
        repo: input.repo,
        target: input.target,
        body: input.body,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      await kv.set([...DRAFT_PREFIX, draft.id], draft);
      return draft;
    },

    async getDraft(id) {
      const entry = await kv.get<Draft>([...DRAFT_PREFIX, id]);
      return entry.value;
    },

    async listDrafts(limit = 50) {
      const drafts: Draft[] = [];
      for await (const entry of kv.list<Draft>({ prefix: [...DRAFT_PREFIX] })) {
        drafts.push(entry.value);
      }
      drafts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return drafts.slice(0, limit);
    },

    async updateDraft(id, patch) {
      const key = [...DRAFT_PREFIX, id];
      const entry = await kv.get<Draft>(key);
      if (entry.value === null) {
        throw new Error(`draft "${id}" not found`);
      }
      const updated: Draft = { ...entry.value, ...patch, id: entry.value.id };
      await kv.set(key, updated);
      return updated;
    },

    async putSession(id, session, ttlMs) {
      await kv.set([...SESSION_PREFIX, id], session, { expireIn: ttlMs });
    },

    async getSession(id) {
      const entry = await kv.get<Session>([...SESSION_PREFIX, id]);
      return entry.value;
    },

    async deleteSession(id) {
      await kv.delete([...SESSION_PREFIX, id]);
    },

    close() {
      kv.close();
    },
  };
}
