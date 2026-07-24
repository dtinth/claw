import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  computePacemaker,
  formatCountdown,
  parseUsageReport,
  renderUsageHtml,
  usageSectionHtml,
} from "./usage.ts";
import type { UsageSnapshot } from "../grist/client.ts";

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// --- computePacemaker ---------------------------------------------------------

Deno.test("computePacemaker: exactly on pace is zero", () => {
  // 1 hour left of 5 → 80% of the window elapsed. Used exactly 80%.
  const now = new Date("2024-03-01T12:00:00Z");
  const resetsAt = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString();
  assertEquals(computePacemaker(80, resetsAt, FIVE_HOUR_MS, now), 0);
});

Deno.test("computePacemaker: the exact example from the request — 80% elapsed, 75% used, is +5", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const resetsAt = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString(); // 1h left of 5h → 80% elapsed
  assertEquals(computePacemaker(75, resetsAt, FIVE_HOUR_MS, now), 5);
});

Deno.test("computePacemaker: using faster than time-proportional pace is negative", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const resetsAt = new Date(now.getTime() + 1 * 60 * 60 * 1000).toISOString(); // 80% elapsed
  assertEquals(computePacemaker(90, resetsAt, FIVE_HOUR_MS, now), -10);
});

Deno.test("computePacemaker: works for the weekly window too", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  // half the week left → 50% elapsed
  const resetsAt = new Date(now.getTime() + WEEK_MS / 2).toISOString();
  assertEquals(computePacemaker(45, resetsAt, WEEK_MS, now), 5);
});

Deno.test("computePacemaker: clamps elapsed fraction at 0 for a reset in the future beyond the window", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  // resets 10 hours from now on a 5-hour window — window hasn't logically started yet by this math; clamp to 0% elapsed
  const resetsAt = new Date(now.getTime() + 10 * 60 * 60 * 1000).toISOString();
  assertEquals(computePacemaker(10, resetsAt, FIVE_HOUR_MS, now), -10);
});

Deno.test("computePacemaker: clamps elapsed fraction at 100 once past the reset time", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const resetsAt = new Date(now.getTime() - 1000).toISOString(); // already past reset
  assertEquals(computePacemaker(90, resetsAt, FIVE_HOUR_MS, now), 10);
});

// --- formatCountdown -----------------------------------------------------------

Deno.test("formatCountdown renders hours and minutes", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const target = new Date(now.getTime() + (60 * 60 + 12 * 60) * 1000).toISOString();
  assertEquals(formatCountdown(target, now), "1h12m");
});

Deno.test("formatCountdown renders days and hours once over a day", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const target = new Date(now.getTime() + (4 * 86400 + 2 * 3600) * 1000).toISOString();
  assertEquals(formatCountdown(target, now), "4d2h");
});

Deno.test("formatCountdown floors at 0 once past the target", () => {
  const now = new Date("2024-03-01T12:00:00Z");
  const target = new Date(now.getTime() - 1000).toISOString();
  assertEquals(formatCountdown(target, now), "0m");
});

// --- renderUsageHtml -----------------------------------------------------------

const NOW = new Date("2024-03-01T12:00:00Z");

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    updated: NOW.getTime() / 1000,
    fiveHourPct: 68,
    fiveHourResetsAt: new Date(NOW.getTime() + 72 * 60 * 1000).toISOString(),
    weeklyPct: 31,
    weeklyResetsAt: new Date(NOW.getTime() + 4 * 86400 * 1000).toISOString(),
    ...overrides,
  };
}

Deno.test("renderUsageHtml shows an empty state when there's no snapshot yet", () => {
  assertStringIncludes(renderUsageHtml(null, NOW), "No usage data yet");
});

Deno.test("renderUsageHtml shows both windows' percentages and countdowns", () => {
  const html = renderUsageHtml(snapshot(), NOW);
  assertStringIncludes(html, "68%");
  assertStringIncludes(html, "31%");
  assertStringIncludes(html, "1h12m");
  assertStringIncludes(html, "4d0h");
});

Deno.test("renderUsageHtml shows a positive pacemaker with a + sign", () => {
  // 5h window, 72 min left → ~76% elapsed; used only 68% → ahead of pace
  const html = renderUsageHtml(snapshot({ fiveHourPct: 68 }), NOW);
  assertStringIncludes(html, "+8%");
});

Deno.test("renderUsageHtml shows a negative pacemaker with a − sign", () => {
  const html = renderUsageHtml(snapshot({ fiveHourPct: 95 }), NOW);
  assertStringIncludes(html, "−19%");
});

Deno.test("renderUsageHtml omits the extra-usage line when not enabled", () => {
  const html = renderUsageHtml(snapshot(), NOW);
  assertEquals(html.includes("Extra usage"), false);
});

Deno.test("renderUsageHtml shows the extra-usage line when enabled", () => {
  const html = renderUsageHtml(snapshot({ extraUsageEnabled: true, extraUsagePct: 12 }), NOW);
  assertStringIncludes(html, "Extra usage");
  assertStringIncludes(html, "12%");
});

// --- parseUsageReport ------------------------------------------------------------

const VALID_REPORT = {
  fiveHourPct: 68,
  fiveHourResetsAt: "2026-07-24T18:30:00Z",
  weeklyPct: 31,
  weeklyResetsAt: "2026-07-28T00:00:00Z",
};

Deno.test("parseUsageReport accepts a valid report", () => {
  const result = parseUsageReport(VALID_REPORT);
  assertEquals(result, { value: VALID_REPORT });
});

Deno.test("parseUsageReport includes extraUsage fields when given", () => {
  const result = parseUsageReport({ ...VALID_REPORT, extraUsage: { enabled: true, pct: 12 } });
  assertEquals(result, {
    value: { ...VALID_REPORT, extraUsageEnabled: true, extraUsagePct: 12 },
  });
});

Deno.test("parseUsageReport ignores a malformed extraUsage block rather than failing", () => {
  const result = parseUsageReport({ ...VALID_REPORT, extraUsage: { enabled: "yes", pct: "high" } });
  assertEquals(result, { value: VALID_REPORT });
});

Deno.test("parseUsageReport rejects a non-object body", () => {
  assertEquals("error" in parseUsageReport(null), true);
  assertEquals("error" in parseUsageReport("nope"), true);
  assertEquals("error" in parseUsageReport(42), true);
});

Deno.test("parseUsageReport rejects a missing or non-numeric fiveHourPct", () => {
  const { fiveHourPct: _drop, ...rest } = VALID_REPORT;
  assertEquals("error" in parseUsageReport(rest), true);
  assertEquals("error" in parseUsageReport({ ...VALID_REPORT, fiveHourPct: "68" }), true);
  assertEquals("error" in parseUsageReport({ ...VALID_REPORT, fiveHourPct: NaN }), true);
});

Deno.test("parseUsageReport rejects a missing or non-numeric weeklyPct", () => {
  const { weeklyPct: _drop, ...rest } = VALID_REPORT;
  assertEquals("error" in parseUsageReport(rest), true);
});

Deno.test("parseUsageReport rejects an unparseable fiveHourResetsAt", () => {
  assertEquals(
    "error" in parseUsageReport({ ...VALID_REPORT, fiveHourResetsAt: "not a date" }),
    true,
  );
});

Deno.test("parseUsageReport rejects an unparseable weeklyResetsAt", () => {
  assertEquals(
    "error" in parseUsageReport({ ...VALID_REPORT, weeklyResetsAt: "not a date" }),
    true,
  );
});

// --- usageSectionHtml ------------------------------------------------------------

Deno.test("usageSectionHtml polls /api/sidebar-usage on a script-driven interval", () => {
  const html = usageSectionHtml();
  assertStringIncludes(html, "/api/sidebar-usage");
  assertStringIncludes(html, "setInterval");
  assertStringIncludes(html, "document.visibilityState");
});
