import { assertEquals, assertThrows } from "@std/assert";
import { formatRepo, parseGitRemoteUrl, parseRepo, RepoError } from "./repo.ts";

Deno.test("parseRepo accepts owner/repo", () => {
  assertEquals(parseRepo("dtinth/claw"), { owner: "dtinth", repo: "claw" });
});

Deno.test("parseRepo trims surrounding whitespace", () => {
  assertEquals(parseRepo("  dtinth/claw  "), { owner: "dtinth", repo: "claw" });
});

Deno.test("parseRepo rejects malformed input", () => {
  assertThrows(() => parseRepo("dtinth"), RepoError);
  assertThrows(() => parseRepo("dtinth/claw/extra"), RepoError);
  assertThrows(() => parseRepo("/claw"), RepoError);
  assertThrows(() => parseRepo("dtinth/"), RepoError);
  assertThrows(() => parseRepo("dt inth/claw"), RepoError);
});

Deno.test("formatRepo renders owner/repo", () => {
  assertEquals(formatRepo({ owner: "dtinth", repo: "claw" }), "dtinth/claw");
});

Deno.test("parseGitRemoteUrl handles the https form", () => {
  assertEquals(parseGitRemoteUrl("https://github.com/dtinth/claw.git"), {
    owner: "dtinth",
    repo: "claw",
  });
});

Deno.test("parseGitRemoteUrl handles https without .git", () => {
  assertEquals(parseGitRemoteUrl("https://github.com/dtinth/claw"), {
    owner: "dtinth",
    repo: "claw",
  });
});

Deno.test("parseGitRemoteUrl handles a credentialed https remote", () => {
  assertEquals(parseGitRemoteUrl("https://x-access-token@github.com/dtinth/claw.git"), {
    owner: "dtinth",
    repo: "claw",
  });
});

Deno.test("parseGitRemoteUrl handles the scp-like ssh form", () => {
  assertEquals(parseGitRemoteUrl("git@github.com:dtinth/claw.git"), {
    owner: "dtinth",
    repo: "claw",
  });
});

Deno.test("parseGitRemoteUrl handles the ssh:// form", () => {
  assertEquals(parseGitRemoteUrl("ssh://git@github.com/dtinth/claw.git"), {
    owner: "dtinth",
    repo: "claw",
  });
});

Deno.test("parseGitRemoteUrl returns null for a non-github host", () => {
  assertEquals(parseGitRemoteUrl("https://gitlab.com/dtinth/claw.git"), null);
});

Deno.test("parseGitRemoteUrl returns null for garbage", () => {
  assertEquals(parseGitRemoteUrl("not a url"), null);
  assertEquals(parseGitRemoteUrl(""), null);
});
