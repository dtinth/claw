import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { authorColor, issuePage, renderCommentsHtml } from "./comment_feed.ts";
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

Deno.test("authorColor hardcodes dtinth to the design system's lime accent", () => {
  assertEquals(authorColor("dtinth"), "#d7fc70");
});

Deno.test("authorColor is deterministic for the same username", () => {
  assertEquals(authorColor("some-bot"), authorColor("some-bot"));
});

Deno.test("authorColor differs between usernames (not a constant)", () => {
  assertNotEquals(authorColor("alice"), authorColor("bob"));
});

Deno.test("renderCommentsHtml colors each comment's author name and renders view-on-GitHub/copy-markdown as icon buttons", () => {
  const html = renderCommentsHtml([comment({ author: "some-bot" })]);
  assertStringIncludes(html, `style="color:${authorColor("some-bot")}"`);
  assertStringIncludes(html, 'class="icon-btn"');
  assertStringIncludes(html, 'icon="bi:github"');
  assertStringIncludes(html, 'icon="bi:clipboard"');
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

Deno.test("renderCommentsHtml colorizes an @mention in the body the same way as its author color", () => {
  const html = renderCommentsHtml([comment({ body: "thanks @some-bot for the fix" })]);
  assertStringIncludes(html, `<span style="color:${authorColor("some-bot")}">@some-bot</span>`);
});

Deno.test("renderCommentsHtml does not colorize an email address as a mention", () => {
  const html = renderCommentsHtml([comment({ body: "reach me at me@example.com" })]);
  assertEquals(html.includes(`color:${authorColor("example")}`), false);
  assertStringIncludes(html, "me@example.com");
});

Deno.test("renderCommentsHtml does not colorize an @-looking token inside a code span", () => {
  const html = renderCommentsHtml([comment({ body: "use the `@decorator` syntax" })]);
  assertEquals(html.includes(`color:${authorColor("decorator")}`), false);
  assertStringIncludes(html, "@decorator");
});

Deno.test("renderCommentsHtml does not colorize an @-looking token inside a fenced code block", () => {
  const html = renderCommentsHtml([comment({ body: "```\n@decorator\ndef f(): pass\n```" })]);
  assertEquals(html.includes(`color:${authorColor("decorator")}`), false);
});

Deno.test("renderCommentsHtml carries each comment's raw markdown for the copy-markdown button", () => {
  const html = renderCommentsHtml([comment({ body: "**bold** source" })]);
  assertStringIncludes(html, "copy-md-btn");
  assertStringIncludes(html, 'class="raw-markdown" hidden');
  assertStringIncludes(html, "**bold** source");
});

Deno.test("renderCommentsHtml sanitizes a script tag out of the comment body", () => {
  const html = renderCommentsHtml([comment({ body: "hi <script>alert(1)</script> there" })]);
  assertEquals(html.includes("<script>"), false);
  assertStringIncludes(html, "hi");
  assertStringIncludes(html, "there");
});

Deno.test("renderCommentsHtml sanitizes an inline event-handler attribute", () => {
  const html = renderCommentsHtml([comment({ body: '<img src=x onerror="alert(1)">' })]);
  // The raw-markdown carrier (for the "copy markdown" button) legitimately
  // contains the escaped word "onerror" as inert text — what must never
  // appear is a live, unescaped attribute.
  assertEquals(html.includes('onerror="'), false);
});

Deno.test("renderCommentsHtml escapes the author name and URL (no injection via Grist data)", () => {
  const html = renderCommentsHtml([
    comment({ author: "<script>alert(1)</script>", url: "javascript:alert(1)" }),
  ]);
  assertEquals(html.includes("<script>alert(1)</script>"), false);
});

Deno.test("renderCommentsHtml shows all comments expanded when there are 5 or fewer", () => {
  const comments = Array.from({ length: 5 }, (_, i) => comment({ commentId: i + 1 }));
  const html = renderCommentsHtml(comments);
  assertEquals(html.includes("<details"), false);
  for (const c of comments) assertStringIncludes(html, `id="issuecomment-${c.commentId}"`);
});

Deno.test("renderCommentsHtml collapses everything but the last 5 behind a <details> toggle", () => {
  const comments = Array.from({ length: 8 }, (_, i) => comment({ commentId: i + 1 }));
  const html = renderCommentsHtml(comments);

  const detailsEnd = html.indexOf("</details>");
  assertStringIncludes(html, "<summary>Show 3 earlier comments</summary>");
  // Comments 1–3 (earlier) must be inside the <details>; 4–8 (recent) outside it.
  for (let id = 1; id <= 3; id++) {
    assertEquals(html.indexOf(`id="issuecomment-${id}"`) < detailsEnd, true);
  }
  for (let id = 4; id <= 8; id++) {
    assertEquals(html.indexOf(`id="issuecomment-${id}"`) > detailsEnd, true);
  }
});

Deno.test("renderCommentsHtml uses singular wording for exactly one earlier comment", () => {
  const comments = Array.from({ length: 6 }, (_, i) => comment({ commentId: i + 1 }));
  assertStringIncludes(renderCommentsHtml(comments), "Show 1 earlier comment<");
});

Deno.test("issuePage embeds the given comments HTML and a Reply link to /draft", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "<p>MARKER</p>" });
  assertStringIncludes(html, "<p>MARKER</p>");
  assertStringIncludes(html, "/draft?repo=dtinth%2Fclaw&amp;issue=24");
});

Deno.test("issuePage has a Reply link at both the top and the bottom", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  const replyCount =
    html.split('<a class="btn-link" href="/draft?repo=dtinth%2Fclaw&amp;issue=24">Reply</a>')
      .length - 1;
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

Deno.test("issuePage styles Reply and Jump-to-latest as buttons (bigger tap target) while staying real links", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, '<a class="btn-link" href="/draft?repo=dtinth%2Fclaw&amp;issue=24">');
  assertStringIncludes(html, '<a class="btn-link" href="#comments-end">');
});

Deno.test("issuePage includes a polling script that refetches with ?partial=1", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "?partial=1");
  assertStringIncludes(html, 'id="comments"');
});

Deno.test("issuePage marks the thread read (for the sidebar) when a latestCommentId is given", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "", latestCommentId: 42 });
  assertStringIncludes(html, "claw-read:dtinth/claw#24");
  assertStringIncludes(html, "localStorage.setItem");
  assertStringIncludes(html, '"42"');
});

Deno.test("issuePage does not touch localStorage when there's no latestCommentId (no comments yet)", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertEquals(html.includes("localStorage.setItem"), false);
});

Deno.test("issuePage forces open an ancestor <details> and scrolls when linked to a specific comment", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "location.hash");
  assertStringIncludes(html, 'closest("details")');
  assertStringIncludes(html, "scrollIntoView()"); // no argument — no smooth-scroll behavior requested
});

Deno.test("issuePage's refresh preserves an open earlier-comments <details> across a poll", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "details.earlier-comments");
  assertStringIncludes(html, "wasOpen");
});

Deno.test("issuePage wires the copy-markdown button via delegation (survives a refresh swap)", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "copy-md-btn");
  assertStringIncludes(html, "raw-markdown");
  assertStringIncludes(html, 'container.addEventListener("click"');
});

Deno.test("issuePage adds a copy button to code blocks, including after a refresh poll", () => {
  const html = issuePage({ repo: "dtinth/claw", issue: 24, commentsHtml: "" });
  assertStringIncludes(html, "copy-code-btn");
  assertStringIncludes(html, "navigator.clipboard.writeText");
  // Called once on load and again after every refresh poll — not just once.
  const calls = html.split("addCopyButtons();").length - 1;
  assertEquals(calls, 2);
});
