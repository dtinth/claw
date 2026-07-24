/**
 * The dashboard sidebar's Claude Code usage meter — `claw usage-report`
 * (agent CLI) submits raw 5-hour/weekly percentages and reset timestamps;
 * everything else here (countdowns, the "pacemaker" delta) is derived fresh
 * at render time from the current clock, the same way `sidebar.ts` derives
 * relative timestamps rather than storing them.
 */
import type { UsageSnapshot } from "../grist/client.ts";
import { escapeHtml } from "./html.ts";

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What `POST /api/usage-report` accepts, once validated. */
export interface UsageReportInput {
  fiveHourPct: number;
  fiveHourResetsAt: string;
  weeklyPct: number;
  weeklyResetsAt: string;
  extraUsageEnabled?: boolean;
  extraUsagePct?: number;
}

/** Parse and validate a `POST /api/usage-report` body. */
export function parseUsageReport(body: unknown): { value: UsageReportInput } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const fiveHourPct = b.fiveHourPct;
  if (typeof fiveHourPct !== "number" || !Number.isFinite(fiveHourPct)) {
    return { error: "fiveHourPct must be a number" };
  }
  const weeklyPct = b.weeklyPct;
  if (typeof weeklyPct !== "number" || !Number.isFinite(weeklyPct)) {
    return { error: "weeklyPct must be a number" };
  }
  const fiveHourResetsAt = b.fiveHourResetsAt;
  if (typeof fiveHourResetsAt !== "string" || Number.isNaN(Date.parse(fiveHourResetsAt))) {
    return { error: "fiveHourResetsAt must be an ISO 8601 timestamp" };
  }
  const weeklyResetsAt = b.weeklyResetsAt;
  if (typeof weeklyResetsAt !== "string" || Number.isNaN(Date.parse(weeklyResetsAt))) {
    return { error: "weeklyResetsAt must be an ISO 8601 timestamp" };
  }

  const value: UsageReportInput = { fiveHourPct, fiveHourResetsAt, weeklyPct, weeklyResetsAt };
  const extraUsage = b.extraUsage;
  if (extraUsage && typeof extraUsage === "object") {
    const e = extraUsage as Record<string, unknown>;
    if (typeof e.enabled === "boolean") value.extraUsageEnabled = e.enabled;
    if (typeof e.pct === "number" && Number.isFinite(e.pct)) value.extraUsagePct = e.pct;
  }
  return { value };
}

/**
 * How far ahead of (positive) or behind (negative) a linear pace through the
 * window you are, in percentage points: `elapsed% − used%`. +5 means you've
 * used 5 points less than a perfectly-paced burn would have by now (buffer);
 * −5 means you've burned 5 points more (at risk of hitting the cap before
 * the window resets).
 */
export function computePacemaker(
  usedPct: number,
  resetsAt: string,
  windowDurationMs: number,
  now: Date,
): number {
  const msUntilReset = new Date(resetsAt).getTime() - now.getTime();
  const elapsedFraction = clamp(1 - msUntilReset / windowDurationMs, 0, 1);
  return Math.round(elapsedFraction * 100 - usedPct);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** `1h12m` / `4d2h` / `0m` — compact countdown to an ISO timestamp. */
export function formatCountdown(target: string, now: Date): string {
  const deltaMs = new Date(target).getTime() - now.getTime();
  const totalMin = Math.max(0, Math.floor(deltaMs / 60_000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

function pacemakerHtml(pct: number, resetsAt: string, windowMs: number, now: Date): string {
  const delta = computePacemaker(pct, resetsAt, windowMs, now);
  const sign = delta >= 0 ? "+" : "−";
  const cls = delta >= 0 ? "pacemaker-ahead" : "pacemaker-behind";
  return `<span class="${cls}">(${sign}${Math.abs(delta)}%)</span>`;
}

function windowRowHtml(
  label: string,
  pct: number,
  resetsAt: string,
  windowMs: number,
  now: Date,
): string {
  return `<div class="usage-row">
    <span class="usage-label">${escapeHtml(label)}</span>
    <span class="usage-pct">${pct}%</span>
    <div class="usage-bar"><div class="usage-bar-fill" style="width:${
    clamp(pct, 0, 100)
  }%"></div></div>
    ${pacemakerHtml(pct, resetsAt, windowMs, now)}
    <span class="usage-resets muted">resets in ${escapeHtml(formatCountdown(resetsAt, now))}</span>
  </div>`;
}

/** Render the usage meter as an HTML fragment (what `GET /api/sidebar-usage` returns). */
export function renderUsageHtml(usage: UsageSnapshot | null, now: Date): string {
  if (!usage) {
    return `<p class="muted">No usage data yet — run <code>claw usage-report</code>.</p>`;
  }
  const extra = usage.extraUsageEnabled
    ? `<div class="usage-row">
        <span class="usage-label">Extra usage</span>
        <span class="usage-pct">${usage.extraUsagePct ?? 0}%</span>
      </div>`
    : "";
  return windowRowHtml("5h", usage.fiveHourPct, usage.fiveHourResetsAt, FIVE_HOUR_MS, now) +
    windowRowHtml("7d", usage.weeklyPct, usage.weeklyResetsAt, WEEK_MS, now) +
    extra;
}

/** How often the usage meter refetches while its tab is visible. */
const REFRESH_INTERVAL_MS = 15_000;

/**
 * The usage meter's static skeleton — embedded in the sidebar above
 * "Recent bot activity". Renders a loading placeholder immediately, then
 * fetches the real numbers.
 */
export function usageSectionHtml(): string {
  return `
    <h3>Claude usage</h3>
    <div id="sidebar-usage" class="usage-meter"><p class="muted">Loading…</p></div>
    <script>
(function () {
  var box = document.getElementById("sidebar-usage");
  function load() {
    fetch("/api/sidebar-usage")
      .then(function (r) { return r.ok ? r.text() : Promise.reject(); })
      .then(function (html) { box.innerHTML = html; })
      .catch(function () { box.innerHTML = '<p class="muted">Couldn\\'t load usage.</p>'; });
  }
  load();
  setInterval(function () {
    if (document.visibilityState === "visible") load();
  }, ${REFRESH_INTERVAL_MS});
})();
    </script>`;
}
