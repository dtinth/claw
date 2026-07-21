import { assertEquals, assertStringIncludes } from "@std/assert";
import { issuePage, renderCommentsHtml } from "./comment_feed.ts";
import type { Comment } from "../grist/client.ts";

function comment(overrides: Partial<Comment> = {}): Comment {
  return {
    commentId: 111,
    repo: "dtinth/claw",
    issue: 24,
    author: "dtinth",
    authorId: 193136,
    body: "hello",
    url: "https://github.com/dtinth/claw/issues/24#issuecomment-111",
    ...overrides,
  };
}

Deno.test("renderCommentsHtml shows an empty state for no comments", () => {
  assertStringIncludes(renderCommentsHtml([]), "No comments yet");
});

Deno.test("renderCommentsHtml renders each comment's author, GitHub link and anchor id", () => {
  const html = renderCommentsHtml([comment()]);
  assertStringIncludes(html, "dtinth");
  assertStringIncludes(html, "https://github.com/dtinth/claw/issues/24#issuecomment-111");
  assertStringIncludes(html, 'id="issuecomment-111"');
});

Deno.test("renderCommentsHtml shows the time when the comment has one", () => {
  const html = renderCommentsHtml([comment({ time: 1709294400 })]);
  assertStringIncludes(html, "<time");
  assertStringIncludes(html, 'datetime="2024-03-01T12:00:00.000Z"');
  assertStringIncludes(html, "2024-03-01 12:00 UTC");
});

Deno.test("renderCommentsHtml omits the time element when the comment has none", () => {
  const html = renderCommentsHtml([comment()]);
  assertEquals(html.includes("<time"), false);
});

Deno.test("renderCommentsHtml renders markdown (GFM) in the comment body", () => {
  const html = renderCommentsHtml([
    comment({ body: "**bold** and a [link](https://example.com)" }),
  ]);
  assertStringIncludes(html, "<strong>bold</strong>");
  assertStringIncludes(html, '<a href="https://example.com"');
});

Deno.test("renderCommentsHtml sanitizes a script tag out of the comment body", () => {
  const html = renderCommentsHtml([comment({ body: "hi <script>alert(1)</script> there" })]);
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "hi");
  assertStringIncludes(html, "there");
});

Deno.test("renderCommentsHtml sanitizes an inline event-handler attribute", () => {
  const html = renderCommentsHtml([comment({ body: '<img src=x onerror="alert(1)">' })]);
  assertEquals(html.includes("onerror"), false);
});

Deno.test("renderCommentsHtml escapes the author name and URL (no injection via Grist data)", () => {
  const html = renderCommentsHtml([
    comment({ author: "<script>alert(1)</script>", url: "javascript:alert(1)" }),
  ]);
  assertEquals(html.includes("<script>alert(1)</script>"), false);
});

Deno.test("issuePage embeds the given comments HTML and a Reply link to /draft", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "<p>MARKER</p>" });
  assertStringIncludes(html, "<p>MARKER</p>");
  assertStringIncludes(html, "/draft?repo=dtinth%2Fclaw&amp;issue=24");
});

Deno.test("issuePage has a Reply link at both the top and the bottom", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  const replyCount =
    html.split('<a href="/draft?repo=dtinth%2Fclaw&amp;issue=24">Reply</a>').length - 1;
  assertEquals(replyCount, 2);
});

Deno.test("issuePage has a 'jump to latest' link pointing at a stable anchor after the comments", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "<p>c</p>" });
  assertStringIncludes(html, 'href="#comments-end"');
  assertStringIncludes(html, 'id="comments-end"');
  // The anchor target must sit outside #comments, since that container's
  // innerHTML gets replaced wholesale on every poll.
  const commentsEnd = html.indexOf('id="comments-end"');
  const commentsDivEnd = html.indexOf("</div>", html.indexOf('id="comments"'));
  assertEquals(commentsEnd > commentsDivEnd, true);
});

Deno.test("issuePage includes a polling script that refetches with ?partial=1", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "?partial=1");
  assertStringIncludes(html, 'id="comments"');
});
