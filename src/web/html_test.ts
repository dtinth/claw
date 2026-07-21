import { assertEquals } from "@std/assert";
import { jsonForScript } from "./html.ts";

Deno.test("jsonForScript serializes a plain value like JSON.stringify", () => {
  assertEquals(jsonForScript("hello"), '"hello"');
  assertEquals(jsonForScript({ a: 1 }), '{"a":1}');
});

Deno.test("jsonForScript neutralizes </script> so it can't close the enclosing script tag", () => {
  const out = jsonForScript("</script><script>alert(1)</script>");
  assertEquals(out.includes("</script>"), false);
  assertEquals(JSON.parse(out.replace(/\\u003c/g, "<")), "</script><script>alert(1)</script>");
});
