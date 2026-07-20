/**
 * A minimal Grist client for the comment relay.
 *
 * Comments ingested from GitHub webhooks are upserted into a Grist table
 * (keyed by the GitHub comment id), and agents poll them back filtered by
 * repository, issue and author. `fetch` is injectable for testing.
 *
 * The table schema (column ids) is fixed by the deployment's Grist document:
 * `Comment_ID`, `Repo`, `Issue`, `User_ID`, `User_Name`, `Body`.
 */
import type { CommentRecord } from "../webhook.ts";

/** A comment returned to an agent from a poll. */
export interface Comment {
  commentId: number;
  repo: string;
  issue: number;
  author: string;
  authorId: number;
  body: string;
  /** The GitHub URL of the comment. */
  url: string;
}

/** Filter for {@link GristClient.queryComments}. */
export interface CommentQuery {
  /** Repository as `owner/repo` (required). */
  repo: string;
  /** Restrict to a single issue/PR number. */
  issue?: number;
  /** Restrict to these comment authors (GitHub logins). */
  authors?: string[];
}

/** Dependencies for {@link createGristClient}. */
export interface GristClientDeps {
  /** Base API URL including the document id. */
  apiUrl: string;
  /** Grist API key, sent as a bearer token. */
  apiKey: string;
  /** Table name. */
  table: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

/** claw's Grist client surface. */
export interface GristClient {
  upsertComment(record: CommentRecord): Promise<void>;
  queryComments(query: CommentQuery): Promise<Comment[]>;
}

/** Thrown when a Grist API call fails. */
export class GristApiError extends Error {
  override name = "GristApiError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface GristRow {
  fields: {
    Comment_ID: number;
    Repo: string;
    Issue: number;
    User_ID: number;
    User_Name: string;
    Body: string;
  };
}

export function createGristClient(deps: GristClientDeps): GristClient {
  const fetchFn = deps.fetch ?? fetch;
  const recordsUrl = `${deps.apiUrl.replace(/\/$/, "")}/tables/${deps.table}/records`;
  const headers = {
    "Authorization": `Bearer ${deps.apiKey}`,
    "Content-Type": "application/json",
  };

  async function fail(response: Response, action: string): Promise<never> {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      detail = "";
    }
    throw new GristApiError(
      response.status,
      `Grist ${action} failed (HTTP ${response.status}): ${detail}`,
    );
  }

  return {
    async upsertComment(record) {
      const { Comment_ID, ...fields } = record;
      const response = await fetchFn(recordsUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify({ records: [{ require: { Comment_ID }, fields }] }),
      });
      if (!response.ok) await fail(response, "upsert");
    },

    async queryComments(query) {
      const filter: Record<string, Array<string | number>> = { Repo: [query.repo] };
      if (query.issue !== undefined) filter.Issue = [query.issue];
      if (query.authors && query.authors.length > 0) filter.User_Name = query.authors;

      const url = new URL(recordsUrl);
      url.searchParams.set("filter", JSON.stringify(filter));
      url.searchParams.set("sort", "Comment_ID");

      const response = await fetchFn(url.toString(), { headers });
      if (!response.ok) await fail(response, "query");

      const payload = await response.json() as { records: GristRow[] };
      return payload.records.map(({ fields: f }) => ({
        commentId: f.Comment_ID,
        repo: f.Repo,
        issue: f.Issue,
        author: f.User_Name,
        authorId: f.User_ID,
        body: f.Body,
        url: `https://github.com/${f.Repo}/issues/${f.Issue}#issuecomment-${f.Comment_ID}`,
      }));
    },
  };
}
