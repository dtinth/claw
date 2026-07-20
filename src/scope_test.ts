import { assertEquals, assertThrows } from "@std/assert";
import { formatScope, parseScope, ScopeParseError } from "./scope.ts";

Deno.test("parseScope parses a well-formed scope", () => {
  assertEquals(parseScope("dtinth/claw:read"), {
    owner: "dtinth",
    repo: "claw",
    permission: "read",
  });
});

Deno.test("parseScope accepts every permission level", () => {
  assertEquals(parseScope("a/b:read").permission, "read");
  assertEquals(parseScope("a/b:write").permission, "write");
  assertEquals(parseScope("a/b:admin").permission, "admin");
});

Deno.test("parseScope rejects an unknown permission", () => {
  assertThrows(() => parseScope("a/b:owner"), ScopeParseError, "unknown permission");
});

Deno.test("parseScope rejects a missing permission", () => {
  assertThrows(() => parseScope("a/b"), ScopeParseError, "owner/repo:permission");
});

Deno.test("parseScope rejects a missing repo", () => {
  assertThrows(() => parseScope("a:read"), ScopeParseError, "owner/repo pair");
});

Deno.test("parseScope rejects illegal characters", () => {
  assertThrows(() => parseScope("a/b c:read"), ScopeParseError, "[A-Za-z0-9._-]");
});

Deno.test("formatScope round-trips parseScope", () => {
  const input = "dtinth/claw:write";
  assertEquals(formatScope(parseScope(input)), input);
});
