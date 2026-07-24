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
  assertStringIncludes(html, '<aside class="app-sidebar"><p>SIDEBAR</p></aside>');
  assertStringIncludes(html, "<p>BODY</p>");
});
