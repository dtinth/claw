import { assertEquals, assertStringIncludes } from "@std/assert";
import { jsonForScript, layout } from "./html.ts";

Deno.test("jsonForScript serializes a plain value like JSON.stringify", () => {
  assertEquals(jsonForScript("hello"), '"hello"');
  assertEquals(jsonForScript({ a: 1 }), '{"a":1}');
});

Deno.test("jsonForScript neutralizes </script> so it can't close the enclosing script tag", () => {
  const out = jsonForScript("</script><script>alert(1)</script>");
  assertEquals(out.includes("</script>"), false);
  assertEquals(JSON.parse(out.replace(/\\u003c/g, "<")), "</script><script>alert(1)</script>");
});

Deno.test("layout renders a plain single column without a sidebar", () => {
  const html = layout("t", "<p>BODY</p>");
  assertStringIncludes(html, "<p>BODY</p>");
  // The STYLE block always defines .app-shell/.app-sidebar rules, so check
  // for the actual markup, not a bare substring match.
  assertEquals(html.includes('<div class="app-shell">'), false);
  assertEquals(html.includes('<aside class="app-sidebar">'), false);
});

Deno.test("layout wraps body and sidebar in the app shell when a sidebar is given", () => {
  const html = layout("t", "<p>BODY</p>", "<p>SIDEBAR</p>");
  assertStringIncludes(html, 'class="app-shell"');
  assertStringIncludes(html, 'id="app-sidebar"');
  assertStringIncludes(html, "<p>SIDEBAR</p>");
  assertStringIncludes(html, "<p>BODY</p>");
  // The sidebar content must be inside the <aside>, not just anywhere on the page.
  const asideStart = html.indexOf('id="app-sidebar"');
  const asideEnd = html.indexOf("</aside>");
  const sidebarContentPos = html.indexOf("<p>SIDEBAR</p>");
  assertEquals(sidebarContentPos > asideStart && sidebarContentPos < asideEnd, true);
});

Deno.test("layout includes a collapse toggle that remembers state in localStorage", () => {
  const html = layout("t", "<p>BODY</p>", "<p>SIDEBAR</p>");
  assertStringIncludes(html, 'id="sidebar-toggle"');
  assertStringIncludes(html, "claw-sidebar-collapsed");
  assertStringIncludes(html, 'classList.toggle("collapsed"');
});

Deno.test("layout has no collapse toggle when there's no sidebar", () => {
  const html = layout("t", "<p>BODY</p>");
  // STYLE always defines a .sidebar-toggle CSS rule, so check for the markup, not a bare substring.
  assertEquals(html.includes('id="sidebar-toggle"'), false);
});

Deno.test("layout loads iconify-icon (for the sidebar's own-reply icon) only when a sidebar is given", () => {
  const withSidebar = layout("t", "<p>BODY</p>", "<p>SIDEBAR</p>");
  assertStringIncludes(withSidebar, "cdn.jsdelivr.net/npm/iconify-icon");
  const withoutSidebar = layout("t", "<p>BODY</p>");
  assertEquals(withoutSidebar.includes("iconify-icon"), false);
});

Deno.test("layout loads relative-time-element (self-updating sidebar timestamps) only when a sidebar is given", () => {
  const withSidebar = layout("t", "<p>BODY</p>", "<p>SIDEBAR</p>");
  assertStringIncludes(withSidebar, "cdn.jsdelivr.net/npm/@github/relative-time-element");
  assertStringIncludes(withSidebar, 'type="module"');
  const withoutSidebar = layout("t", "<p>BODY</p>");
  assertEquals(withoutSidebar.includes("relative-time-element"), false);
});
