import { assertEquals, assertStringIncludes } from "@std/assert";
import { createApp } from "./app.ts";
import { createClawJwt, verifyClawJwt } from "../jwt.ts";
import { openStore, type Store } from "../store.ts";
import type { Config } from "../config.ts";
import type { GitHubClient } from "../github/client.ts";

const config: Config = {
  appId: "123456",
  privateKeyPem: "unused-in-web-tests",
  clientId: "Iv1.client",
  clientSecret: "secret",
  jwtSecret: "jwt-secret",
  sessionSecret: "session-secret",
  baseUrl: "https://claw.example.com",
  allowedLogin: "dtinth",
  port: 8000,
  kvPath: undefined,
};

/** A GitHub client fake; override individual methods per test. */
function fakeGitHub(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const notUsed = (name: string) => () => {
    throw new Error(`unexpected call: ${name}`);
  };
  return {
    mintRepoToken: notUsed("mintRepoToken"),
    buildAuthorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
    exchangeCode: notUsed("exchangeCode"),
    getAuthenticatedUser: notUsed("getAuthenticatedUser"),
    postIssueComment: notUsed("postIssueComment"),
    postDiscussionComment: notUsed("postDiscussionComment"),
    ...overrides,
  };
}

async function withApp(
  github: GitHubClient,
  run: (app: ReturnType<typeof createApp>, store: Store) => Promise<void>,
) {
  const store = await openStore(":memory:");
  try {
    const app = createApp({ config, store, github });
    await run(app, store);
  } finally {
    store.close();
  }
}

/** Create a logged-in session and return its cookie header. */
async function login(store: Store, login = "dtinth"): Promise<string> {
  const id = "test-session-id";
  await store.putSession(id, {
    login,
    accessToken: "ghu_usertoken",
    createdAt: new Date().toISOString(),
  }, 60_000);
  return `claw_session=${id}`;
}

Deno.test("GET /healthz returns ok", async () => {
  await withApp(fakeGitHub(), async (app) => {
    const res = await app.request("/healthz");
    assertEquals(res.status, 200);
  });
});

Deno.test("GET / shows a login link when logged out", async () => {
  await withApp(fakeGitHub(), async (app) => {
    const res = await app.request("/");
    assertEquals(res.status, 200);
    assertStringIncludes(await res.text(), "/auth/login");
  });
});

Deno.test("GET / shows the dashboard when logged in", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    const cookie = await login(store);
    const res = await app.request("/", { headers: { cookie } });
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, "dtinth");
    assertStringIncludes(html, "Mint");
  });
});

Deno.test("a session for a different login is not accepted", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    const cookie = await login(store, "someone-else");
    const res = await app.request("/", { headers: { cookie } });
    // treated as logged out
    assertStringIncludes(await res.text(), "/auth/login");
  });
});

Deno.test("POST /api/token exchanges a claw JWT for an installation token", async () => {
  let calledWith: { repo: string; perms: unknown } | null = null;
  const github = fakeGitHub({
    mintRepoToken: (repo, perms) => {
      calledWith = { repo, perms };
      return Promise.resolve({
        token: "ghs_scopedtoken",
        expiresAt: "2026-07-20T01:00:00Z",
        repository: repo,
        permissions: perms,
      });
    },
  });
  await withApp(github, async (app) => {
    const jwt = await createClawJwt(
      { repo: "dtinth/claw", permissions: { contents: "read", issues: "write" }, ttlSeconds: 3600 },
      config.jwtSecret,
    );
    const res = await app.request("/api/token", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.token, "ghs_scopedtoken");
    assertEquals(body.repository, "dtinth/claw");
    assertEquals(calledWith, {
      repo: "dtinth/claw",
      perms: { contents: "read", issues: "write" },
    });
  });
});

Deno.test("POST /api/token logs each exchange with the JWT id (jti)", async () => {
  const github = fakeGitHub({
    mintRepoToken: (repo, perms) =>
      Promise.resolve({
        token: "ghs_scopedtoken",
        expiresAt: "2026-07-20T01:00:00Z",
        repository: repo,
        permissions: perms,
      }),
  });
  await withApp(github, async (app) => {
    const jwt = await createClawJwt(
      {
        repo: "dtinth/claw",
        permissions: { contents: "read" },
        ttlSeconds: 3600,
        label: "agent-x",
      },
      config.jwtSecret,
    );
    const grant = await verifyClawJwt(jwt, config.jwtSecret);

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const res = await app.request("/api/token", {
        method: "POST",
        headers: { authorization: `Bearer ${jwt}` },
      });
      assertEquals(res.status, 200);
    } finally {
      console.log = original;
    }

    const line = logs.find((l) => l.includes("token-exchange") && l.includes(grant.jti));
    assertStringIncludes(line ?? "", grant.jti);
    assertStringIncludes(line ?? "", "dtinth/claw");
  });
});

Deno.test("POST /api/token rejects a missing token with 401", async () => {
  await withApp(fakeGitHub(), async (app) => {
    const res = await app.request("/api/token", { method: "POST" });
    assertEquals(res.status, 401);
  });
});

Deno.test("POST /api/token rejects an invalid token with 401", async () => {
  await withApp(fakeGitHub(), async (app) => {
    const res = await app.request("/api/token", {
      method: "POST",
      headers: { authorization: "Bearer not.a.jwt" },
    });
    assertEquals(res.status, 401);
  });
});

Deno.test("POST /api/drafts stores a draft for any repo and returns a review url", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    // JWT scoped to one repo, draft targets a different public repo — allowed.
    const jwt = await createClawJwt(
      { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 3600 },
      config.jwtSecret,
    );
    const res = await app.request("/api/drafts", {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      body: JSON.stringify({
        repo: "someone/other",
        target: { kind: "issue", issueNumber: 12 },
        body: "Proposed reply",
      }),
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertStringIncludes(body.url, "https://claw.example.com/drafts/");
    const stored = await store.getDraft(body.id);
    assertEquals(stored?.repo, "someone/other");
    assertEquals(stored?.status, "pending");
  });
});

Deno.test("POST /api/drafts rejects an unauthenticated request", async () => {
  await withApp(fakeGitHub(), async (app) => {
    const res = await app.request("/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "a/b", target: { kind: "issue", issueNumber: 1 }, body: "x" }),
    });
    assertEquals(res.status, 401);
  });
});

Deno.test("GET /drafts/:id redirects to login when logged out", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    const draft = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 1 },
      body: "hi",
    });
    const res = await app.request(`/drafts/${draft.id}`, { redirect: "manual" });
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/auth/login");
  });
});

Deno.test("GET /drafts/:id renders the draft when logged in", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    const cookie = await login(store);
    const draft = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 5 },
      body: "Body <script>bad</script> text",
    });
    const res = await app.request(`/drafts/${draft.id}`, { headers: { cookie } });
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, "dtinth/claw");
    // body is escaped, not executed
    assertStringIncludes(html, "&lt;script&gt;");
  });
});

Deno.test("POST /drafts/:id/post posts an issue comment as the user", async () => {
  let posted: { token: string; repo: string; n: number; body: string } | null = null;
  const github = fakeGitHub({
    postIssueComment: (token, repo, n, body) => {
      posted = { token, repo, n, body };
      return Promise.resolve({ htmlUrl: "https://github.com/dtinth/claw/issues/5#issuecomment-1" });
    },
  });
  await withApp(github, async (app, store) => {
    const cookie = await login(store);
    const draft = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 5 },
      body: "Thanks for the report!",
    });
    const res = await app.request(`/drafts/${draft.id}/post`, {
      method: "POST",
      headers: { cookie },
      redirect: "manual",
    });
    assertEquals(res.status, 302);
    assertEquals(posted, {
      token: "ghu_usertoken",
      repo: "dtinth/claw",
      n: 5,
      body: "Thanks for the report!",
    });
    const stored = await store.getDraft(draft.id);
    assertEquals(stored?.status, "posted");
    assertEquals(stored?.postedUrl, "https://github.com/dtinth/claw/issues/5#issuecomment-1");
  });
});

Deno.test("POST /jwt mints a claw JWT from the dashboard form", async () => {
  await withApp(fakeGitHub(), async (app, store) => {
    const cookie = await login(store);
    const form = new URLSearchParams({
      repo: "dtinth/claw",
      lifetime_amount: "30",
      lifetime_unit: "days",
      "perm_contents": "read",
      "perm_issues": "write",
      label: "my agent",
    });
    const res = await app.request("/jwt", {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    assertEquals(res.status, 200);
    const html = await res.text();
    // A JWT begins with the base64url of {"alg":"HS256"...} => "eyJ"
    assertStringIncludes(html, "eyJ");
  });
});
