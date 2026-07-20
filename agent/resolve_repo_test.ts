import { assertEquals, assertRejects } from "@std/assert";
import { RepoResolutionError, resolveRepo } from "./resolve_repo.ts";

function neverCallGitRemote(): Promise<string | null> {
  throw new Error("must not be called");
}

Deno.test("resolveRepo prefers the explicit --repo value", async () => {
  const repo = await resolveRepo({
    explicit: "dtinth/claw",
    env: { CLAW_REPO: "someone/else" },
    getGitRemoteUrl: neverCallGitRemote,
  });
  assertEquals(repo, "dtinth/claw");
});

Deno.test("resolveRepo falls back to CLAW_REPO when no explicit value", async () => {
  const repo = await resolveRepo({
    env: { CLAW_REPO: "dtinth/claw" },
    getGitRemoteUrl: neverCallGitRemote,
  });
  assertEquals(repo, "dtinth/claw");
});

Deno.test("resolveRepo falls back to the git origin remote", async () => {
  const repo = await resolveRepo({
    env: {},
    getGitRemoteUrl: () => Promise.resolve("git@github.com:dtinth/claw.git"),
  });
  assertEquals(repo, "dtinth/claw");
});

Deno.test("resolveRepo throws an actionable error when nothing resolves", async () => {
  await assertRejects(
    () => resolveRepo({ env: {}, getGitRemoteUrl: () => Promise.resolve(null) }),
    RepoResolutionError,
  );
});

Deno.test("resolveRepo throws when the git remote isn't a github.com url", async () => {
  await assertRejects(
    () =>
      resolveRepo({
        env: {},
        getGitRemoteUrl: () => Promise.resolve("https://gitlab.com/dtinth/claw.git"),
      }),
    RepoResolutionError,
  );
});

Deno.test("resolveRepo surfaces a malformed explicit --repo as-is", async () => {
  await assertRejects(
    () => resolveRepo({ explicit: "not-a-repo", env: {}, getGitRemoteUrl: neverCallGitRemote }),
    Error,
    "not-a-repo",
  );
});
