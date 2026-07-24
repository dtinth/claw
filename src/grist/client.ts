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
  /** When the comment was created, as epoch seconds — absent for rows written before the `Time` column existed. */
  time?: number;
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
  /** Table name for comments. */
  table: string;
  /** Table name for the Claude usage snapshot. */
  usageTable: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
}

/**
 * A Claude Code usage snapshot, as `claw usage-report` submits it — one
 * account-wide row, upserted on every poll (not a history log).
 */
export interface UsageSnapshot {
  /** When this snapshot was recorded, as epoch seconds. */
  updated: number;
  fiveHourPct: number;
  /** ISO 8601 — when the 5-hour window resets. */
  fiveHourResetsAt: string;
  weeklyPct: number;
  /** ISO 8601 — when the 7-day window resets. */
  weeklyResetsAt: string;
  /** Only present on plans with the extra-usage/overage tier enabled. */
  extraUsageEnabled?: boolean;
  extraUsagePct?: number;
}

/** Filter for {@link GristClient.listActivity}. */
export interface ActivityQuery {
  /** Restrict to these comment authors (GitHub logins), across all repos. */
  authors: string[];
  /** Cap the number of rows Grist returns (most recent first). */
  limit: number;
}

/** claw's Grist client surface. */
export interface GristClient {
  upsertComment(record: CommentRecord): Promise<void>;
  queryComments(query: CommentQuery): Promise<Comment[]>;
  /** The `authors`' most recent comments across all repos, newest first. */
  listActivity(query: ActivityQuery): Promise<Comment[]>;
  upsertUsage(snapshot: UsageSnapshot): Promise<void>;
  /** The current usage snapshot, or `null` if `claw usage-report` has never run. */
  getUsage(): Promise<UsageSnapshot | null>;
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
    /** Absent for rows written before the `Time` column existed. */
    Time?: number;
  };
}

/** `Row_Kind` is a fixed constant so upserts always target the same single row. */
const USAGE_ROW_KIND = "current";

interface UsageGristRow {
  fields: {
    Row_Kind: string;
    Updated: number;
    FiveHourPct: number;
    /** A native Grist DateTime column: read back as epoch seconds (possibly fractional), not the ISO string it was written with. */
    FiveHourResetsAt: number;
    WeeklyPct: number;
    WeeklyResetsAt: number;
    ExtraUsageEnabled?: boolean;
    ExtraUsagePct?: number;
  };
}

function mapUsageRow({ fields: f }: UsageGristRow): UsageSnapshot {
  return {
    updated: f.Updated,
    fiveHourPct: f.FiveHourPct,
    fiveHourResetsAt: new Date(f.FiveHourResetsAt * 1000).toISOString(),
    weeklyPct: f.WeeklyPct,
    weeklyResetsAt: new Date(f.WeeklyResetsAt * 1000).toISOString(),
    ...(typeof f.ExtraUsageEnabled === "boolean" ? { extraUsageEnabled: f.ExtraUsageEnabled } : {}),
    ...(typeof f.ExtraUsagePct === "number" ? { extraUsagePct: f.ExtraUsagePct } : {}),
  };
}

export function createGristClient(deps: GristClientDeps): GristClient {
  const fetchFn = deps.fetch ?? fetch;
  const recordsUrl = `${deps.apiUrl.replace(/\/$/, "")}/tables/${deps.table}/records`;
  const usageRecordsUrl = `${deps.apiUrl.replace(/\/$/, "")}/tables/${deps.usageTable}/records`;
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

  function mapRow({ fields: f }: GristRow): Comment {
    return {
      commentId: f.Comment_ID,
      repo: f.Repo,
      issue: f.Issue,
      author: f.User_Name,
      authorId: f.User_ID,
      body: f.Body,
      ...(typeof f.Time === "number" ? { time: f.Time } : {}),
      url: `https://github.com/${f.Repo}/issues/${f.Issue}#issuecomment-${f.Comment_ID}`,
    };
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
      return payload.records.map(mapRow);
    },

    async listActivity({ authors, limit }) {
      const url = new URL(recordsUrl);
      url.searchParams.set("filter", JSON.stringify({ User_Name: authors }));
      url.searchParams.set("sort", "-Time");
      url.searchParams.set("limit", String(limit));

      const response = await fetchFn(url.toString(), { headers });
      if (!response.ok) await fail(response, "query");

      const payload = await response.json() as { records: GristRow[] };
      return payload.records.map(mapRow);
    },

    async upsertUsage(snapshot) {
      const { extraUsageEnabled, extraUsagePct, ...rest } = snapshot;
      const fields = {
        Row_Kind: USAGE_ROW_KIND,
        Updated: rest.updated,
        FiveHourPct: rest.fiveHourPct,
        FiveHourResetsAt: rest.fiveHourResetsAt,
        WeeklyPct: rest.weeklyPct,
        WeeklyResetsAt: rest.weeklyResetsAt,
        ...(extraUsageEnabled !== undefined ? { ExtraUsageEnabled: extraUsageEnabled } : {}),
        ...(extraUsagePct !== undefined ? { ExtraUsagePct: extraUsagePct } : {}),
      };
      const response = await fetchFn(usageRecordsUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify({ records: [{ require: { Row_Kind: USAGE_ROW_KIND }, fields }] }),
      });
      if (!response.ok) await fail(response, "usage upsert");
    },

    async getUsage() {
      const url = new URL(usageRecordsUrl);
      url.searchParams.set("filter", JSON.stringify({ Row_Kind: [USAGE_ROW_KIND] }));

      const response = await fetchFn(url.toString(), { headers });
      if (!response.ok) await fail(response, "usage query");

      const payload = await response.json() as { records: UsageGristRow[] };
      const row = payload.records[0];
      return row ? mapUsageRow(row) : null;
    },
  };
}
