import { assertEquals, assertRejects } from "@std/assert";
import { ClawJwtError, createClawJwt, verifyClawJwt } from "./jwt.ts";

const SECRET = "test-secret-please-ignore";

Deno.test("createClawJwt + verifyClawJwt round-trips a grant", async () => {
  const token = await createClawJwt({
    repo: "dtinth/claw",
    permissions: { contents: "read", issues: "write" },
    ttlSeconds: 3600,
    label: "my agent",
  }, SECRET);

  const grant = await verifyClawJwt(token, SECRET);
  assertEquals(grant.repo, "dtinth/claw");
  assertEquals(grant.permissions, { contents: "read", issues: "write" });
  assertEquals(grant.label, "my agent");
  assertEquals(typeof grant.jti, "string");
  assertEquals(grant.expiresAt.getTime() > grant.issuedAt.getTime(), true);
});

Deno.test("createClawJwt rejects empty permissions (would be full access)", async () => {
  await assertRejects(
    () => createClawJwt({ repo: "dtinth/claw", permissions: {}, ttlSeconds: 3600 }, SECRET),
    ClawJwtError,
    "at least one permission",
  );
});

Deno.test("createClawJwt rejects a non-positive lifetime", async () => {
  await assertRejects(
    () =>
      createClawJwt(
        { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 0 },
        SECRET,
      ),
    ClawJwtError,
    "lifetime",
  );
});

Deno.test("createClawJwt rejects an invalid repo", async () => {
  await assertRejects(
    () =>
      createClawJwt(
        { repo: "not-a-repo", permissions: { contents: "read" }, ttlSeconds: 60 },
        SECRET,
      ),
    ClawJwtError,
  );
});

Deno.test("verifyClawJwt rejects a token signed with a different secret", async () => {
  const token = await createClawJwt(
    { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 60 },
    SECRET,
  );
  await assertRejects(() => verifyClawJwt(token, "other-secret"), ClawJwtError);
});

Deno.test("verifyClawJwt rejects a tampered token", async () => {
  const token = await createClawJwt(
    { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 60 },
    SECRET,
  );
  const tampered = token.slice(0, -3) + "aaa";
  await assertRejects(() => verifyClawJwt(tampered, SECRET), ClawJwtError);
});

Deno.test("verifyClawJwt rejects an expired token", async () => {
  const past = new Date(Date.now() - 3600_000);
  const token = await createClawJwt(
    { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 1, now: past },
    SECRET,
  );
  await assertRejects(() => verifyClawJwt(token, SECRET), ClawJwtError, "expired");
});
