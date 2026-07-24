import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatRelativeTime,
  groupLatestActivity,
  renderActivityHtml,
  sidebarHtml,
} from "./sidebar.ts";
import type { Comment } from "../grist/client.ts";

const BOT = "dtinth-claw[bot]";
const HUMAN = "dtinth";
const OPTS = { botAuthor: BOT, humanAuthor: HUMAN, maxItems: 20 };

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    commentId: 1,
    repo: "dtinth/claw",
    issue: 5,
    author: BOT,
    authorId: 1,
    body: "hi",
    url: "https://github.com/dtinth/claw/issues/5#issuecomment-1",
    ...overrides,
  };
}

// --- groupLatestActivity -----------------------------------------------------

Deno.test("groupLatestActivity keeps the first (most recent) bot row per repo+issue", () => {
  const rows = [
    comment({ commentId: 3, issue: 5, time: 300 }),
    comment({ commentId: 2, issue: 5, time: 200 }), // same issue as above — dropped
    comment({ commentId: 1, issue: 7, time: 100 }),
  ];
  const items = groupLatestActivity(rows, OPTS);
  assertEquals(items.map((i) => ({ repo: i.repo, issue: i.issue, time: i.time })), [
    { repo: "dtinth/claw", issue: 5, time: 300 },
    { repo: "dtinth/claw", issue: 7, time: 100 },
  ]);
});

Deno.test("groupLatestActivity ignores rows from other authors when choosing the group's entry", () => {
  const rows = [
    comment({ author: HUMAN, issue: 5, time: 300 }), // human's own comment — not a bot row
    comment({ author: BOT, issue: 5, time: 200 }),
  ];
  const items = groupLatestActivity(rows, OPTS);
  assertEquals(items.length, 1);
  assertEquals(items[0]!.time, 200); // the bot's row, not the human's newer one
});

Deno.test("groupLatestActivity distinguishes issues with the same number in different repos", () => {
  const rows = [
    comment({ repo: "a/x", issue: 5, time: 200 }),
    comment({ repo: "b/y", issue: 5, time: 100 }),
  ];
  assertEquals(groupLatestActivity(rows, OPTS).length, 2);
});

Deno.test("groupLatestActivity caps the result at maxItems groups", () => {
  const rows = [
    comment({ issue: 1, time: 300 }),
    comment({ issue: 2, time: 200 }),
    comment({ issue: 3, time: 100 }),
  ];
  const items = groupLatestActivity(rows, { ...OPTS, maxItems: 2 });
  assertEquals(items.map((i) => i.issue), [1, 2]);
});

Deno.test("groupLatestActivity omits time when the row has none", () => {
  assertEquals("time" in groupLatestActivity([comment()], OPTS)[0]!, false);
});

Deno.test("groupLatestActivity excerpts from the start of the body when there's no mention", () => {
  const items = groupLatestActivity([comment({ body: "just an update, nothing urgent" })], OPTS);
  assertEquals(items[0]!.excerpt, "just an update, nothing urgent");
  assertEquals(items[0]!.prominent, undefined);
});

Deno.test("groupLatestActivity excerpts from the @mention onward and flags it prominent", () => {
  const items = groupLatestActivity(
    [comment({ body: "Ran the full suite. @dtinth can you confirm the deploy target?" })],
    OPTS,
  );
  assertEquals(items[0]!.excerpt, "@dtinth can you confirm the deploy target?");
  assertEquals(items[0]!.prominent, true);
});

Deno.test("groupLatestActivity mention matching is case-insensitive and word-bounded", () => {
  assertEquals(
    groupLatestActivity([comment({ body: "hey @Dtinth check this" })], OPTS)[0]!.prominent,
    true,
  );
  // "@dtinthy" is a different user — must not match as a mention of "dtinth".
  assertEquals(
    groupLatestActivity([comment({ body: "cc @dtinthy" })], OPTS)[0]!.prominent,
    undefined,
  );
});

Deno.test("groupLatestActivity truncates a long excerpt with an ellipsis", () => {
  const items = groupLatestActivity([comment({ body: "x".repeat(300) })], OPTS);
  assertEquals(items[0]!.excerpt.length, 141); // 140 chars + "…"
  assertEquals(items[0]!.excerpt.endsWith("…"), true);
});

Deno.test("groupLatestActivity does not mark a mention prominent once the human replied since", () => {
  const rows = [
    comment({ author: BOT, issue: 5, time: 100, body: "@dtinth please review" }),
    comment({ author: HUMAN, issue: 5, time: 200, body: "done, thanks" }),
  ];
  const items = groupLatestActivity(rows, OPTS);
  assertEquals(items[0]!.prominent, undefined);
});

Deno.test("groupLatestActivity keeps a mention prominent if the human's reply is older, not newer", () => {
  const rows = [
    comment({ author: HUMAN, issue: 5, time: 50, body: "earlier context" }),
    comment({ author: BOT, issue: 5, time: 100, body: "@dtinth please review" }),
  ];
  const items = groupLatestActivity(rows, OPTS);
  assertEquals(items[0]!.prominent, true);
});

Deno.test("groupLatestActivity carries the chosen comment's id, for the sidebar's deep link and read tracking", () => {
  const items = groupLatestActivity([comment({ commentId: 42 })], OPTS);
  assertEquals(items[0]!.commentId, 42);
});

Deno.test("groupLatestActivity only clears prominence for a reply on the same issue", () => {
  const rows = [
    comment({ repo: "dtinth/claw", author: BOT, issue: 5, time: 100, body: "@dtinth ping" }),
    comment({ repo: "dtinth/claw", author: HUMAN, issue: 6, time: 200, body: "unrelated reply" }),
  ];
  const items = groupLatestActivity(rows, OPTS);
  assertEquals(items[0]!.prominent, true);
});

// --- formatRelativeTime -------------------------------------------------------

Deno.test("formatRelativeTime renders each unit tier", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const secs = (n: number) => now.getTime() / 1000 - n;
  assertEquals(formatRelativeTime(secs(30), now), "just now");
  assertEquals(formatRelativeTime(secs(90), now), "2 minutes ago");
  assertEquals(formatRelativeTime(secs(60), now), "1 minute ago");
  assertEquals(formatRelativeTime(secs(3600 * 5), now), "5 hours ago");
  assertEquals(formatRelativeTime(secs(86400 * 3), now), "3 days ago");
  assertEquals(formatRelativeTime(secs(86400 * 60), now), "2 months ago");
  assertEquals(formatRelativeTime(secs(86400 * 400), now), "1 year ago");
});

// --- renderActivityHtml -------------------------------------------------------

const NOW = new Date("2024-03-01T12:00:00Z");

Deno.test("renderActivityHtml shows an empty state", () => {
  assertStringIncludes(renderActivityHtml([], NOW), "No activity");
});

Deno.test("renderActivityHtml links each item to the specific comment on claw's own feed, with excerpt and relative time", () => {
  const html = renderActivityHtml(
    [{ repo: "dtinth/claw", issue: 5, commentId: 42, time: 1709294400, excerpt: "an excerpt" }],
    NOW,
  );
  assertStringIncludes(html, 'href="/dtinth/claw/issues/5#issuecomment-42"');
  assertStringIncludes(html, "dtinth/claw#5");
  assertStringIncludes(html, "an excerpt");
  assertStringIncludes(html, "<time");
});

Deno.test("renderActivityHtml omits the time element when the item has none", () => {
  const html = renderActivityHtml(
    [{ repo: "dtinth/claw", issue: 5, commentId: 1, excerpt: "x" }],
    NOW,
  );
  assertEquals(html.includes("<time"), false);
});

Deno.test("renderActivityHtml marks a prominent item distinctly and tags it for client-side read tracking", () => {
  const html = renderActivityHtml(
    [{ repo: "dtinth/claw", issue: 5, commentId: 42, excerpt: "@dtinth ping", prominent: true }],
    NOW,
  );
  assertStringIncludes(html, 'class="prominent"');
  assertStringIncludes(html, 'class="excerpt prominent"');
  assertStringIncludes(html, 'data-repo="dtinth/claw"');
  assertStringIncludes(html, 'data-issue="5"');
  assertStringIncludes(html, 'data-comment-id="42"');
});

Deno.test("renderActivityHtml does not mark a non-prominent item, nor tag it with read-tracking data", () => {
  const html = renderActivityHtml(
    [{ repo: "dtinth/claw", issue: 5, commentId: 1, excerpt: "routine" }],
    NOW,
  );
  assertEquals(html.includes("prominent"), false);
  assertEquals(html.includes("data-comment-id"), false);
});

Deno.test("renderActivityHtml escapes the repo and excerpt (defense in depth)", () => {
  const html = renderActivityHtml(
    [{
      repo: "<script>alert(1)</script>/x",
      issue: 5,
      commentId: 1,
      excerpt: "<script>alert(2)</script>",
    }],
    NOW,
  );
  assertEquals(html.includes("<script>alert(1)</script>"), false);
  assertEquals(html.includes("<script>alert(2)</script>"), false);
});

// --- sidebarHtml ---------------------------------------------------------------

Deno.test("sidebarHtml polls every 15s only while the tab is visible", () => {
  const html = sidebarHtml();
  assertStringIncludes(html, "15000");
  assertStringIncludes(html, "document.visibilityState");
  assertStringIncludes(html, '"visible"');
});

Deno.test("sidebarHtml loads immediately on render, not just on the first interval tick", () => {
  const html = sidebarHtml();
  const scriptBody = html.slice(html.indexOf("<script>"));
  assertStringIncludes(scriptBody.slice(0, scriptBody.indexOf("setInterval")), "load();");
});

Deno.test("sidebarHtml applies client-side read state and offers a mark-as-unread control", () => {
  const html = sidebarHtml();
  assertStringIncludes(html, "claw-read:");
  assertStringIncludes(html, "data-comment-id");
  assertStringIncludes(html, "Mark as unread");
  assertStringIncludes(html, "applyReadState");
});
