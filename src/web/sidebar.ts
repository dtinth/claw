/**
 * The dashboard's "recent bot activity" sidebar: the issues/PRs
 * `dtinth-claw[bot]` has most recently commented on, across every repo the
 * relay has ever seen — a plain read of Grist, loaded asynchronously by the
 * dashboard's own script so it never blocks the page's initial render.
 */
import type { Comment } from "../grist/client.ts";
import { formatTime } from "./comment_feed.ts";
import { escapeHtml } from "./html.ts";

/** The GitHub login whose activity the sidebar tracks. */
export const ACTIVITY_AUTHOR = "dtinth-claw[bot]";

/** How many distinct issues/PRs the sidebar shows. */
export const ACTIVITY_MAX_ITEMS = 20;

/**
 * How many raw comment rows to ask Grist for before grouping. Fetches both
 * the bot's and the human's comments interleaved (to detect "already
 * replied"), so this needs more headroom than a bot-only fetch would.
 */
export const ACTIVITY_FETCH_LIMIT = 400;

const EXCERPT_MAX_LENGTH = 140;

export interface ActivityItem {
  repo: string;
  issue: number;
  /** The comment this entry represents — also the sidebar link's `#issuecomment-<id>` scroll target. */
  commentId: number;
  time?: number;
  excerpt: string;
  /** True when the excerpt starts at an unaddressed @mention of the human. */
  prominent?: boolean;
  /** True when the thread's latest comment is the human's own — already replied, nothing pending. */
  ownReply?: boolean;
}

/**
 * If `body` @-mentions `humanAuthor`, the excerpt starts at that mention
 * (so the reason it matters is the first thing you see) and is flagged as
 * a mention; otherwise the excerpt is just the start of the body.
 */
function findExcerpt(body: string, humanAuthor: string): { text: string; mentioned: boolean } {
  const pattern = new RegExp(`@${humanAuthor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const match = pattern.exec(body);
  if (match) {
    return { text: body.slice(match.index).trim(), mentioned: true };
  }
  return { text: body.trim(), mentioned: false };
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max).trimEnd() + "…" : collapsed;
}

export interface GroupLatestActivityOptions {
  botAuthor: string;
  /** The human whose @mentions are surfaced, and whose later reply clears them. */
  humanAuthor: string;
  maxItems: number;
}

/**
 * Reduce `rows` (sorted newest-first, a mix of the bot's and the human's
 * comments) to one entry per repo+issue — whichever of the two commented
 * there most recently — capped at `maxItems` groups. When the bot's
 * comment is the latest, a mention of `humanAuthor` is surfaced
 * prominently. When the human's own comment is the latest, the entry is
 * flagged {@link ActivityItem.ownReply} instead (already replied, nothing
 * pending) — since it's the newest row for that thread, no later bot
 * mention could still be outstanding.
 */
export function groupLatestActivity(
  rows: Comment[],
  opts: GroupLatestActivityOptions,
): ActivityItem[] {
  const seen = new Set<string>();
  const items: ActivityItem[] = [];
  for (const c of rows) {
    if (c.author !== opts.botAuthor && c.author !== opts.humanAuthor) continue;
    const key = `${c.repo}#${c.issue}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const isOwnReply = c.author === opts.humanAuthor;
    const { text, mentioned } = isOwnReply
      ? { text: c.body.trim(), mentioned: false }
      : findExcerpt(c.body, opts.humanAuthor);

    items.push({
      repo: c.repo,
      issue: c.issue,
      commentId: c.commentId,
      ...(c.time !== undefined ? { time: c.time } : {}),
      excerpt: truncate(text, EXCERPT_MAX_LENGTH),
      ...(mentioned ? { prominent: true } : {}),
      ...(isOwnReply ? { ownReply: true } : {}),
    });
    if (items.length >= opts.maxItems) break;
  }
  return items;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** `2 hours ago` — GitHub-style, coarsest matching unit, rounded. */
export function formatRelativeTime(epochSeconds: number, now: Date): string {
  const diffSec = Math.round((now.getTime() - epochSeconds * 1000) / 1000);
  if (diffSec < 60) return "just now";

  const minutes = diffSec / 60;
  if (minutes < 60) return plural(Math.round(minutes), "minute");

  const hours = minutes / 60;
  if (hours < 24) return plural(Math.round(hours), "hour");

  const days = hours / 24;
  if (days < 30) return plural(Math.round(days), "day");

  const months = days / 30;
  if (months < 12) return plural(Math.round(months), "month");

  const years = months / 12;
  return plural(Math.round(years), "year");
}

/**
 * Render the activity list as an HTML fragment (what `GET /api/sidebar-activity`
 * returns). A prominent item carries `data-repo`/`data-issue`/`data-comment-id`
 * so the sidebar's own script (see {@link sidebarHtml}) can look up its
 * client-side "read" state and, if already read, demote it and offer
 * "Mark as unread" — that tracking is deliberately client-only, so the
 * server always renders the mention-based prominence as if unread.
 */
export function renderActivityHtml(items: ActivityItem[], now: Date): string {
  if (items.length === 0) {
    return `<li class="muted">No activity yet.</li>`;
  }
  return items.map((item) => {
    const time = typeof item.time === "number"
      ? ` <time datetime="${escapeHtml(new Date(item.time * 1000).toISOString())}" title="${
        escapeHtml(formatTime(item.time))
      }">${escapeHtml(formatRelativeTime(item.time, now))}</time>`
      : "";
    const excerptClass = item.prominent ? "excerpt prominent" : "excerpt";
    const liAttrs = item.prominent
      ? ` class="prominent" data-repo="${escapeHtml(item.repo)}" data-issue="${item.issue}"` +
        ` data-comment-id="${item.commentId}"`
      : "";
    const ownReplyIcon = item.ownReply
      ? `<span class="own-reply-icon" title="You already replied" aria-hidden="true">↩</span> `
      : "";
    return `<li${liAttrs}>
      <a href="/${escapeHtml(item.repo)}/issues/${item.issue}#issuecomment-${item.commentId}">${
      escapeHtml(item.repo)
    }#${item.issue}</a>${time}
      <p class="${excerptClass}">${ownReplyIcon}${escapeHtml(item.excerpt)}</p>
    </li>`;
  }).join("\n");
}

/** How often the sidebar refetches while its tab is visible. */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * The sidebar's static skeleton — embedded inside the shared `layout()`'s
 * `<aside>`. Renders a loading placeholder immediately, then fetches the
 * real list and applies the client-side "read" overrides (see
 * {@link renderActivityHtml}): a thread is marked read by visiting its
 * comment feed page (`issuePage` in comment_feed.ts writes the same
 * `claw-read:<repo>#<issue>` key), which this then uses to demote a
 * mention from prominent — with a "Mark as unread" control to undo it.
 */
export function sidebarHtml(): string {
  return `
    <h3>Recent bot activity</h3>
    <ul id="sidebar-activity" class="sidebar-list"><li class="muted">Loading…</li></ul>
    <script>
(function () {
  var list = document.getElementById("sidebar-activity");

  function applyReadState() {
    var items = list.querySelectorAll("li.prominent[data-comment-id]");
    for (var i = 0; i < items.length; i++) {
      (function (li) {
        var key = "claw-read:" + li.getAttribute("data-repo") + "#" + li.getAttribute("data-issue");
        var readId;
        try { readId = localStorage.getItem(key); } catch (e) { readId = null; }
        if (readId === null || Number(readId) < Number(li.getAttribute("data-comment-id"))) return;

        var excerpt = li.querySelector(".excerpt");
        li.classList.remove("prominent");
        if (excerpt) excerpt.classList.remove("prominent");

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "mark-unread-icon";
        btn.title = "Mark as unread";
        btn.setAttribute("aria-label", "Mark as unread");
        btn.textContent = "↺";
        btn.addEventListener("click", function () {
          try { localStorage.removeItem(key); } catch (e) {}
          li.classList.add("prominent");
          if (excerpt) excerpt.classList.add("prominent");
          btn.remove();
        });
        var link = li.querySelector("a");
        if (link) link.insertAdjacentElement("afterend", btn);
        else li.appendChild(btn);
      })(items[i]);
    }
  }

  function load() {
    fetch("/api/sidebar-activity")
      .then(function (r) { return r.ok ? r.text() : Promise.reject(); })
      .then(function (html) { list.innerHTML = html; applyReadState(); })
      .catch(function () { list.innerHTML = '<li class="muted">Couldn\\'t load activity.</li>'; });
  }
  load();
  setInterval(function () {
    if (document.visibilityState === "visible") load();
  }, ${REFRESH_INTERVAL_MS});
})();
    </script>`;
}
