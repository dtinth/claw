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
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(formatTime(c.time))}</time>`;
}

/**
 * A deterministic per-username color (OKLCH, hue from a simple string hash)
 * so recurring commenters are visually distinguishable at a glance without
 * needing avatars. `dtinth` is hardcoded to the design system's signature
 * lime rather than hashed, since it's already "the" accent for the author.
 */
export function authorColor(author: string): string {
  if (author === "dtinth") return "#d7fc70";
  let hash = 0;
  for (let i = 0; i < author.length; i++) {
    hash = (hash * 31 + author.charCodeAt(i)) >>> 0;
  }
  return `oklch(78% 0.15 ${hash % 360})`;
}

// Private-use-area codepoints as marker delimiters: they never appear in
// real comment text and aren't HTML-special, so they survive GFM rendering
// untouched and can be swapped for real markup afterwards.
const MARK_START = "";
const MARK_END = "";

/** A GitHub-style @mention — not preceded by a word char (so `me@x.com` doesn't match), username rules (alnum/hyphen, no leading/trailing hyphen, <=39 chars). */
const MENTION_RE = /(?<![\w@])@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?)\b/g;
const CODE_SPAN_RE = /```[\s\S]*?```|`[^`\n]*`/g;

/**
 * Render a comment body as markdown, with `@mentions` colorized the same
 * way as the comment author's own name ({@link authorColor}). `@deno/gfm`
 * doesn't auto-link mentions (it has no repo context to resolve them
 * against), so this is done with a placeholder swap around the render:
 * mentions (and code spans, so a mention-shaped token inside a code
 * snippet isn't touched) are marked before rendering, then the markers are
 * replaced with real `<span>` markup in the rendered HTML.
 */
function renderCommentBody(body: string): string {
  const codeSpans: string[] = [];
  const withoutCode = body.replace(CODE_SPAN_RE, (m) => {
    codeSpans.push(m);
    return `${MARK_START}C${codeSpans.length - 1}${MARK_END}`;
  });

  const mentionHtml: string[] = [];
  const withMentionMarkers = withoutCode.replace(MENTION_RE, (_m, username: string) => {
    mentionHtml.push(
      `<span style="color:${authorColor(username)}">@${escapeHtml(username)}</span>`,
    );
    return `${MARK_START}M${mentionHtml.length - 1}${MARK_END}`;
  });

  const restored = withMentionMarkers.replace(
    new RegExp(`${MARK_START}C(\\d+)${MARK_END}`, "g"),
    (_m, i: string) => codeSpans[Number(i)]!,
  );

  const html = renderMarkdown(restored);
  const withMentions = html.replace(
    new RegExp(`${MARK_START}M(\\d+)${MARK_END}`, "g"),
    (_m, i: string) => mentionHtml[Number(i)]!,
  );
  return openLinksInNewTab(withMentions);
}

/**
 * Make every link in rendered comment HTML open in a new tab. GFM's
 * sanitizer already appends `rel="noopener noreferrer"` — but only to
 * links that actually navigate away (a same-page `#fragment` link gets no
 * `rel` at all), so anchoring the replacement there both targets exactly
 * the right links and leaves in-page anchors alone.
 */
function openLinksInNewTab(html: string): string {
  return html.replace(/rel="noopener noreferrer">/g, 'target="_blank" rel="noopener noreferrer">');
}

function renderComment(c: Comment): string {
  return `
    <div class="comment-card" id="issuecomment-${c.commentId}">
      <p class="comment-meta">
        <span class="comment-author" style="color:${authorColor(c.author)}">${
    escapeHtml(c.author)
  }</span>
        ${commentTimeHtml(c)}
        <span class="comment-actions">
          <a class="icon-btn" href="${
    escapeHtml(c.url)
  }" target="_blank" rel="noopener" title="View on GitHub" aria-label="View on GitHub">
            <iconify-icon icon="bi:github"></iconify-icon>
          </a>
          <button type="button" class="icon-btn copy-md-btn" title="Copy markdown" aria-label="Copy markdown">
            <iconify-icon icon="bi:clipboard"></iconify-icon>
          </button>
        </span>
      </p>
      <textarea class="raw-markdown" hidden>${escapeHtml(c.body)}</textarea>
      ${renderCommentBody(c.body)}
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
  /* Pin GFM's rendering to the dt.in.th warm-dark palette instead of its
     own GitHub dark theme (see html.ts's :root tokens for the source). */
  [data-color-mode=dark][data-dark-theme=dark] {
    --color-fg-default: #e9e8e7;
    --color-fg-muted: #8b8685;
    --color-canvas-default: #353433;
    --color-canvas-subtle: #090807;
    --color-border-default: #656463;
    --color-border-muted: #454443;
    --color-accent-fg: #ffffbb;
    --color-accent-emphasis: #d7fc70;
    --color-danger-fg: #fca5a5;
  }
  .markdown-body { font-family: var(--font-sans); }
  .markdown-body code, .markdown-body pre { font-family: var(--font-mono); }
  .comment-card {
    border: 1px solid var(--border-weak); border-radius: var(--radius-lg);
    padding: .8rem 1rem; margin: .8rem 0; background: var(--bg-base); box-shadow: var(--shadow-offset);
  }
  .comment-meta {
    margin: 0 0 .5rem; display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  }
  .comment-author { font-weight: 700; }
  .comment-meta time { font-size: .75rem; color: #8b8685; }
  .comment-actions { margin-left: auto; display: flex; gap: .3rem; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.8rem; height: 1.8rem; font-size: 1rem;
    border: 1px solid #8b8685; border-radius: var(--radius-md);
    background: transparent; color: #8b8685; cursor: pointer;
    text-decoration: none; transition: all 300ms ease-out;
  }
  .icon-btn:hover {
    color: var(--fg-primary); border-color: var(--fg-primary);
    text-decoration: none; transition-duration: 0ms;
  }
  .comment-card pre { position: relative; }
  .copy-code-btn {
    position: absolute; top: .4rem; right: .4rem;
    font-size: .7rem; padding: .15rem .5rem; line-height: 1.4;
    border-radius: var(--radius-sm); border: 1px solid var(--border-base);
    background: var(--bg-elev); color: var(--fg-primary); cursor: pointer;
  }
  .copy-code-btn:hover { border-color: var(--border-strong); }
`;

/**
 * A convention (documented in the operator's `~/.claude/CLAUDE.md`) for
 * offering one-click reply buttons: a trailing HTML comment naming short
 * reply options, invisible in the rendered comment —
 * ```
 * <!--
 * Quick replies:
 * - (A)
 * - (B)
 * -->
 * ```
 * Only meaningful on the thread's latest comment; once a human has replied,
 * the suggestions are stale and the caller shouldn't look for them.
 */
export function parseQuickReplies(body: string): string[] {
  const match = body.match(/<!--\s*Quick replies:\s*([\s\S]*?)-->/i);
  if (!match) return [];
  return match[1]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);
}

export interface IssuePageParams {
  repo: string;
  issue: number;
  commentsHtml: string;
  /** The most recent comment's id, if any — written to the sidebar's client-side "read" tracking on load. */
  latestCommentId?: number;
  /** Parsed via {@link parseQuickReplies} from the thread's latest comment, if any. */
  quickReplies?: string[];
}

/**
 * The full page body (wrapped in the shared `layout()` by the caller).
 * Visiting this page marks the thread "read" in localStorage — the
 * dashboard sidebar (`sidebar.ts`) reads that same key to stop showing an
 * `@mention` here as prominent once you've actually seen the thread.
 */
export function issuePage(params: IssuePageParams): string {
  const draftHref = `/draft?repo=${encodeURIComponent(params.repo)}&issue=${params.issue}`;
  const replyLink = `<a class="btn-link" href="${escapeHtml(draftHref)}">Reply</a>`;
  const readKey = `claw-read:${params.repo}#${params.issue}`;
  // Clicking one only pre-fills the draft form (via the existing ?body=
  // param) — never posts directly. Two trailing newlines leave room to add
  // to the preset text without having to type a newline first; the server
  // trims trailing whitespace on post if that room goes unused.
  const quickReplyLinks = (params.quickReplies ?? [])
    .map((text) => {
      const href = `${draftHref}&body=${encodeURIComponent(text + "\n\n")}`;
      return `<a class="btn-link" href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
    })
    .join(" ");
  return `
  <style>${PAGE_STYLE}</style>
  <script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.8/dist/morphdom-umd.min.js"></script>
  <p>${replyLink} <a class="btn-link" href="#comments-end">Jump to latest ↓</a></p>
  <div id="comments" data-color-mode="dark" data-dark-theme="dark"
    class="markdown-body">${params.commentsHtml}</div>
  <div id="comments-end"></div>
  <p>${replyLink}${quickReplyLinks ? " " + quickReplyLinks : ""}</p>
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

  function addCopyButtons() {
    container.querySelectorAll("pre").forEach(function (pre) {
      if (pre.querySelector(".copy-code-btn")) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-code-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", function () {
        var codeEl = pre.querySelector("code") || pre;
        navigator.clipboard.writeText(codeEl.textContent).then(function () {
          btn.textContent = "Copied!";
          setTimeout(function () { btn.textContent = "Copy"; }, 1500);
        }).catch(function () {});
      });
      pre.appendChild(btn);
    });
  }
  addCopyButtons();

  // Delegated (not per-button) so it keeps working after refresh() swaps
  // in fresh comment cards without needing a re-attach step.
  container.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy-md-btn");
    if (!btn) return;
    var card = btn.closest(".comment-card");
    var raw = card && card.querySelector(".raw-markdown");
    var icon = btn.querySelector("iconify-icon");
    if (!raw || !icon) return;
    navigator.clipboard.writeText(raw.value).then(function () {
      var original = icon.getAttribute("icon");
      icon.setAttribute("icon", "bi:check2");
      setTimeout(function () { icon.setAttribute("icon", original); }, 1500);
    }).catch(function () {});
  });

  function refresh() {
    fetch(location.pathname + "?partial=1")
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (html === null) return;
        var details = container.querySelector("details.earlier-comments");
        var wasOpen = !!(details && details.open);
        // morphdom (not innerHTML) so unchanged nodes — notably <img>s in
        // comment bodies — aren't torn down and reloaded on every poll.
        // It matches elements by id, which every .comment-card already has.
        morphdom(
          container,
          '<div id="comments" data-color-mode="dark" data-dark-theme="dark" class="markdown-body">'
            + html + "</div>",
        );
        if (wasOpen) {
          var newDetails = container.querySelector("details.earlier-comments");
          if (newDetails) newDetails.open = true;
        }
        addCopyButtons();
      })
      .catch(function () {});
  }
  setInterval(refresh, 10000);
})();
  </script>`;
}
