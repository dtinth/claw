import { assertEquals } from "@std/assert";
import { createHmac } from "node:crypto";
import { parseIssueCommentEvent, verifyWebhookSignature } from "./webhook.ts";

const SECRET = "webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

Deno.test("verifyWebhookSignature accepts a correct signature", () => {
  const body = '{"hello":"world"}';
  assertEquals(verifyWebhookSignature(SECRET, body, sign(body)), true);
});

Deno.test("verifyWebhookSignature rejects a wrong signature", () => {
  const body = '{"hello":"world"}';
  assertEquals(verifyWebhookSignature(SECRET, body, sign("tampered")), false);
});

Deno.test("verifyWebhookSignature rejects a missing or malformed header", () => {
  const body = "x";
  assertEquals(verifyWebhookSignature(SECRET, body, null), false);
  assertEquals(verifyWebhookSignature(SECRET, body, ""), false);
  assertEquals(verifyWebhookSignature(SECRET, body, "garbage"), false);
});

Deno.test("verifyWebhookSignature rejects a signature for a different secret", () => {
  const body = '{"a":1}';
  const otherSig = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
  assertEquals(verifyWebhookSignature(SECRET, body, otherSig), false);
});

Deno.test("parseIssueCommentEvent extracts a created comment", () => {
  const payload = {
    action: "created",
    issue: { number: 844 },
    comment: {
      id: 5015219517,
      body: "Is the bridge working?",
      user: { login: "dtinth", id: 193136 },
      created_at: "2024-03-01T12:00:00Z",
    },
    repository: { full_name: "bemusic/bemuse" },
  };
  assertEquals(parseIssueCommentEvent("issue_comment", payload), {
    Comment_ID: 5015219517,
    Repo: "bemusic/bemuse",
    Issue: 844,
    User_ID: 193136,
    User_Name: "dtinth",
    Body: "Is the bridge working?",
    Time: 1709294400,
  });
});

Deno.test("parseIssueCommentEvent handles an edited comment", () => {
  const payload = {
    action: "edited",
    issue: { number: 1 },
    comment: {
      id: 2,
      body: "updated",
      user: { login: "a", id: 3 },
      created_at: "2024-01-01T00:00:00Z",
    },
    repository: { full_name: "o/r" },
  };
  assertEquals(parseIssueCommentEvent("issue_comment", payload)?.Body, "updated");
});

Deno.test("parseIssueCommentEvent ignores non-issue_comment events", () => {
  assertEquals(parseIssueCommentEvent("push", {}), null);
  assertEquals(parseIssueCommentEvent("discussion_comment", {}), null);
});

Deno.test("parseIssueCommentEvent ignores deleted comments", () => {
  const payload = {
    action: "deleted",
    issue: { number: 1 },
    comment: {
      id: 2,
      body: "gone",
      user: { login: "a", id: 3 },
      created_at: "2024-01-01T00:00:00Z",
    },
    repository: { full_name: "o/r" },
  };
  assertEquals(parseIssueCommentEvent("issue_comment", payload), null);
});

Deno.test("parseIssueCommentEvent returns null on a malformed payload", () => {
  assertEquals(parseIssueCommentEvent("issue_comment", { action: "created" }), null);
  assertEquals(parseIssueCommentEvent("issue_comment", null), null);
});

Deno.test("parseIssueCommentEvent returns null when created_at is missing or unparseable", () => {
  const base = {
    action: "created",
    issue: { number: 1 },
    comment: { id: 2, body: "x", user: { login: "a", id: 3 } },
    repository: { full_name: "o/r" },
  };
  assertEquals(parseIssueCommentEvent("issue_comment", base), null);
  assertEquals(
    parseIssueCommentEvent("issue_comment", {
      ...base,
      comment: { ...base.comment, created_at: "not a date" },
    }),
    null,
  );
});
