/**
 * Comment drafts as stateless prefilled-form links.
 *
 * Instead of storing drafts, an agent simply builds a URL:
 *   `${BASE_URL}/draft?repo=owner/repo&issue=42&body=…`
 * and hands it to you. Opening it (authenticated) shows an editable, prefilled
 * comment form you can post from. Nothing is created server-side.
 */
import { parseRepo } from "./github/repo.ts";

/** Where a drafted comment should be posted. */
export type DraftTarget =
  | { kind: "issue"; issueNumber: number }
  | { kind: "discussion"; discussionNumber: number; replyToId?: string };

/** A parsed draft: a target and the (editable) body. */
export interface DraftInput {
  repo: string;
  target: DraftTarget;
  body: string;
}

/**
 * Parse `/draft` query parameters into a {@link DraftInput}. The body may be
 * empty (you fill it in on the form). Returns `{ error }` on invalid input.
 *
 * Accepts either `issue=N` (issues and pull requests) or `discussion=N`
 * (with optional `replyTo`).
 */
export function parseDraftParams(
  params: URLSearchParams,
): { value: DraftInput } | { error: string } {
  const repo = (params.get("repo") ?? "").trim();
  try {
    parseRepo(repo);
  } catch {
    return { error: "repo must be a valid owner/repo" };
  }

  const body = params.get("body") ?? "";

  const issue = params.get("issue");
  const discussion = params.get("discussion");

  if (issue !== null) {
    const n = Number(issue);
    if (!Number.isInteger(n) || n <= 0) return { error: "issue must be a positive integer" };
    return { value: { repo, body, target: { kind: "issue", issueNumber: n } } };
  }
  if (discussion !== null) {
    const n = Number(discussion);
    if (!Number.isInteger(n) || n <= 0) return { error: "discussion must be a positive integer" };
    const target: DraftTarget = { kind: "discussion", discussionNumber: n };
    const replyTo = params.get("replyTo");
    if (replyTo) target.replyToId = replyTo;
    return { value: { repo, body, target } };
  }
  return { error: "either issue or discussion is required" };
}
