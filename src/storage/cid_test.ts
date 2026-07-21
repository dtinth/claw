import { assertEquals, assertNotEquals } from "@std/assert";
import { computeCid } from "./cid.ts";

Deno.test("computeCid is deterministic for the same bytes and filename", async () => {
  const data = new TextEncoder().encode("hello world\n");
  const a = await computeCid(data, "hello.txt");
  const b = await computeCid(data, "hello.txt");
  assertEquals(a, b);
  assertEquals(a, "bafybeidhkumeonuwkebh2i4fc7o7lguehauradvlk57gzake6ggjsy372a");
});

Deno.test("computeCid changes when the filename changes", async () => {
  const data = new TextEncoder().encode("hello world\n");
  const a = await computeCid(data, "hello.txt");
  const b = await computeCid(data, "other.txt");
  assertNotEquals(a, b);
});

Deno.test("computeCid changes when the content changes", async () => {
  const a = await computeCid(new TextEncoder().encode("one"), "file.txt");
  const b = await computeCid(new TextEncoder().encode("two"), "file.txt");
  assertNotEquals(a, b);
});
