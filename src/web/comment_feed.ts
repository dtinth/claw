/**
 * The `/:owner/:repo/issues/:number` (and `/pull/:number`) live comment feed
 * — a Grist-backed read of a single issue/PR's relayed comments, rendered as
 * sanitized GitHub-flavored markdown. No live GitHub API call: this is
 * purely a view over whatever the webhook relay already stored.
 */
import { CSS as GFM_CSS, render as renderMarkdown } from "jsr:@deno/gfm@^0.12";
import type { Comment } from "../grist/client.ts";
import { escapeHtml, jsonForScript } from "./html.ts";

/** `2024-03-01 12:00 UTC` — fixed to UTC since this renders server-side, with no visitor timezone to use. */
export function formatTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString()
    .replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, " UTC");
}

function commentTimeHtml(c: Comment): string {
  if (typeof c.time !== "number") return "";
  const iso = new Date(c.time * 1000).toISOString();
  return ` — <time datetime="${escapeHtml(iso)}">${escapeHtml(formatTime(c.time))}</time>`;
}

function renderComment(c: Comment): string {
  return `
    <div class="comment-card" id="issuecomment-${c.commentId}">
      <p class="comment-meta"><strong>${escapeHtml(c.author)}</strong> —
        <a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">view on GitHub</a>${
    commentTimeHtml(c)
  }</p>
      ${renderMarkdown(c.body)}
    </div>`;
}

/** How many of the most recent comments show expanded by default; older ones collapse behind a toggle. */
const VISIBLE_COUNT = 5;

/**
 * Render the comment list as an HTML fragment (used for both the full page
 * and `?partial=1` polls). Only the last {@link VISIBLE_COUNT} comments are
 * expanded; anything earlier sits behind a native `<details>` toggle, so a
 * long thread doesn't dump its whole history on every load.
 */
export function renderCommentsHtml(comments: Comment[]): string {
  if (comments.length === 0) {
    return `<p class="muted">No comments yet.</p>`;
  }
  const earlier = comments.slice(0, -VISIBLE_COUNT);
  const recent = comments.slice(-VISIBLE_COUNT);
  const earlierHtml = earlier.length === 0 ? "" : `
    <details class="earlier-comments">
      <summary>Show ${earlier.length} earlier comment${earlier.length === 1 ? "" : "s"}</summary>
      ${earlier.map(renderComment).join("\n")}
    </details>`;
  return earlierHtml + recent.map(renderComment).join("\n");
}

const PAGE_STYLE = `
  ${GFM_CSS}
  .comment-card { border: 1px solid #8884; border-radius: 8px; padding: .8rem 1rem; margin: .8rem 0; }
  .comment-meta { margin: 0 0 .5rem; }
`;

export interface IssuePageParams {
  repo: string;
  issue: number;
  commentsHtml: string;
  /** The most recent comment's id, if any — written to the sidebar's client-side "read" tracking on load. */
  latestCommentId?: number;
}

/**
 * The full page body (wrapped in the shared `layout()` by the caller).
 * Visiting this page marks the thread "read" in localStorage — the
 * dashboard sidebar (`sidebar.ts`) reads that same key to stop showing an
 * `@mention` here as prominent once you've actually seen the thread.
 */
export function issuePage(params: IssuePageParams): string {
  const draftHref = `/draft?repo=${encodeURIComponent(params.repo)}&issue=${params.issue}`;
  const replyLink = `<a href="${escapeHtml(draftHref)}">Reply</a>`;
  const readKey = `claw-read:${params.repo}#${params.issue}`;
  return `
  <style>${PAGE_STYLE}</style>
  <p>${replyLink} · <a href="#comments-end">Jump to latest ↓</a></p>
  <div id="comments" data-color-mode="auto" data-light-theme="light" data-dark-theme="dark"
    class="markdown-body">${params.commentsHtml}</div>
  <div id="comments-end"></div>
  <p>${replyLink}</p>
  <script>
(function () {
  var container = document.getElementById("comments");

  ${
    params.latestCommentId !== undefined
      ? `try { localStorage.setItem(${jsonForScript(readKey)}, ${
        jsonForScript(String(params.latestCommentId))
      }); } catch (e) {}`
      : ""
  }

  // A direct link to a comment (e.g. from the sidebar) may point inside the
  // collapsed "earlier comments" <details> — force it open before the
  // browser's own fragment-navigation scroll runs.
  if (location.hash) {
    var target = document.querySelector(location.hash);
    if (target) {
      var details = target.closest("details");
      if (details) details.open = true;
      target.scrollIntoView();
    }
  }

  function refresh() {
    fetch(location.pathname + "?partial=1")
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (html === null) return;
        var details = container.querySelector("details.earlier-comments");
        var wasOpen = !!(details && details.open);
        container.innerHTML = html;
        if (wasOpen) {
          var newDetails = container.querySelector("details.earlier-comments");
          if (newDetails) newDetails.open = true;
        }
      })
      .catch(function () {});
  }
  setInterval(refresh, 10000);
})();
  </script>`;
}
