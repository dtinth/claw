/**
 * Incoming GitHub webhook handling: signature verification and normalization
 * of `issue_comment` events into the record shape stored in Grist.
 *
 * The Grist `Comments` table is issue-comment shaped (its `Link` column builds
 * an `…/issues/{Issue}#issuecomment-{Comment_ID}` URL), so only `issue_comment`
 * events (which cover both issues and pull requests) are ingested here.
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

/** A comment normalized to the Grist `Comments` table columns. */
export interface CommentRecord {
  Comment_ID: number;
  Repo: string;
  Issue: number;
  User_ID: number;
  User_Name: string;
  Body: string;
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header against the shared
 * secret using a constant-time comparison.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string | Uint8Array,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; a length mismatch is already a fail.
  if (received.length !== computed.length) return false;
  return timingSafeEqual(received, computed);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/**
 * Normalize an `issue_comment` webhook payload into a {@link CommentRecord}.
 * Returns null for non-`issue_comment` events, deleted comments, or malformed
 * payloads.
 */
export function parseIssueCommentEvent(eventName: string, payload: unknown): CommentRecord | null {
  if (eventName !== "issue_comment") return null;
  const p = asRecord(payload);
  if (!p) return null;
  if (p.action === "deleted") return null;

  const comment = asRecord(p.comment);
  const issue = asRecord(p.issue);
  const repository = asRecord(p.repository);
  const user = asRecord(comment?.user);
  if (!comment || !issue || !repository || !user) return null;

  const record: CommentRecord = {
    Comment_ID: comment.id as number,
    Repo: repository.full_name as string,
    Issue: issue.number as number,
    User_ID: user.id as number,
    User_Name: user.login as string,
    Body: comment.body as string,
  };

  if (
    typeof record.Comment_ID !== "number" ||
    typeof record.Repo !== "string" ||
    typeof record.Issue !== "number" ||
    typeof record.User_ID !== "number" ||
    typeof record.User_Name !== "string" ||
    typeof record.Body !== "string"
  ) {
    return null;
  }
  return record;
}
