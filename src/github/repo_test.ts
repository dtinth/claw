import { assertEquals, assertThrows } from "@std/assert";
import { formatRepo, parseRepo, RepoParseError } from "./repo.ts";

Deno.test("parseRepo parses owner/repo", () => {
  assertEquals(parseRepo("dtinth/claw"), { owner: "dtinth", repo: "claw" });
});

Deno.test("parseRepo allows dotted, dashed and underscored names", () => {
  assertEquals(parseRepo("My-Org/some_repo.js"), {
    owner: "My-Org",
    repo: "some_repo.js",
  });
});

Deno.test("parseRepo trims surrounding whitespace", () => {
  assertEquals(parseRepo("  dtinth/claw  "), { owner: "dtinth", repo: "claw" });
});

Deno.test("parseRepo rejects a missing slash", () => {
  assertThrows(() => parseRepo("claw"), RepoParseError, "owner/repo");
});

Deno.test("parseRepo rejects extra segments", () => {
  assertThrows(() => parseRepo("a/b/c"), RepoParseError, "owner/repo");
});

Deno.test("parseRepo rejects empty owner or repo", () => {
  assertThrows(() => parseRepo("/claw"), RepoParseError);
  assertThrows(() => parseRepo("dtinth/"), RepoParseError);
});

Deno.test("parseRepo rejects illegal characters", () => {
  assertThrows(() => parseRepo("dtinth/cl aw"), RepoParseError, "characters");
  assertThrows(() => parseRepo("dtinth/cl~aw"), RepoParseError, "characters");
});

Deno.test("formatRepo round-trips parseRepo", () => {
  assertEquals(formatRepo(parseRepo("dtinth/claw")), "dtinth/claw");
});
