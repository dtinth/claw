import { assertEquals, assertStringIncludes } from "@std/assert";
import { createHmac } from "node:crypto";
import { createApp } from "./app.ts";
import { createClawJwt, verifyClawJwt } from "../jwt.ts";
import { encodeSession } from "../session.ts";
import type { Config } from "../config.ts";
import type { GitHubClient } from "../github/client.ts";
import { GitHubApiError } from "../github/client.ts";
import type { Comment, CommentQuery, GristClient } from "../grist/client.ts";
import type { CommentRecord } from "../webhook.ts";
import { InvalidFilenameError, type UploadResult, type UploadService } from "../storage/upload.ts";

const config: Config = {
  appId: "123456",
  privateKeyPem: "unused-in-web-tests",
  clientId: "Iv1.client",
  clientSecret: "secret",
  oauthScopes: "public_repo",
  jwtSecret: "jwt-secret",
  baseUrl: "https://claw.example.com",
  allowedLogin: "dtinth",
  port: 8000,
  webhookSecret: undefined,
  grist: undefined,
  uploadStorage: undefined,
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
    refreshUserToken: notUsed("refreshUserToken"),
    getAuthenticatedUser: notUsed("getAuthenticatedUser"),
    postIssueComment: notUsed("postIssueComment"),
    postDiscussionComment: notUsed("postDiscussionComment"),
    ...overrides,
  };
}

interface AppExtras {
  config?: Config;
  grist?: GristClient;
  uploads?: UploadService;
}

function makeApp(github: GitHubClient, extras: AppExtras = {}) {
  return createApp({
    config: extras.config ?? config,
    github,
    ...(extras.grist ? { grist: extras.grist } : {}),
    ...(extras.uploads ? { uploads: extras.uploads } : {}),
  });
}

/** A Grist client fake; override individual methods per test. */
function fakeGrist(overrides: Partial<GristClient> = {}): GristClient {
  return {
    upsertComment: () => Promise.resolve(),
    queryComments: () => Promise.resolve([]),
    listActivity: () => Promise.resolve([]),
    ...overrides,
  };
}

/** An upload service fake; override `upload` per test. */
function fakeUploads(overrides: Partial<UploadService> = {}): UploadService {
  const result: UploadResult = {
    cid: "bafybeidhkumeonuwkebh2i4fc7o7lguehauradvlk57gzake6ggjsy372a",
    key: "ipfs/bafybeidhkumeonuwkebh2i4fc7o7lguehauradvlk57gzake6ggjsy372a/hello.txt",
    url:
      "https://im.example.com/ipfs/bafybeidhkumeonuwkebh2i4fc7o7lguehauradvlk57gzake6ggjsy372a/hello.txt",
  };
  return {
    upload: () => Promise.resolve(result),
    ...overrides,
  };
}

const WEBHOOK_SECRET = "webhook-secret";
const webhookConfig: Config = { ...config, webhookSecret: WEBHOOK_SECRET };

function signBody(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

/** Build a valid session cookie header for the given login. */
async function sessionCookie(login = "dtinth"): Promise<string> {
  const cookie = await encodeSession(
    { login, accessToken: "ghu_usertoken", createdAt: new Date().toISOString() },
    config.jwtSecret,
    3600,
  );
  return `claw_session=${cookie}`;
}

Deno.test("GET /healthz returns ok", async () => {
  const res = await makeApp(fakeGitHub()).request("/healthz");
  assertEquals(res.status, 200);
});

Deno.test("GET / shows a login link when logged out", async () => {
  const res = await makeApp(fakeGitHub()).request("/");
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "/auth/login");
});

Deno.test("GET / shows the dashboard when logged in", async () => {
  const res = await makeApp(fakeGitHub()).request("/", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "dtinth");
  assertStringIncludes(html, "Mint");
});

Deno.test("dashboard offers one-click permission presets", async () => {
  const res = await makeApp(fakeGitHub()).request("/", {
    headers: { cookie: await sessionCookie() },
  });
  const html = await res.text();
  assertStringIncludes(html, 'data-claw-preset="agent"');
  assertStringIncludes(html, "Read-only");
  assertStringIncludes(html, "Coding agent");
  assertStringIncludes(html, "var presets ="); // the applier script
});

Deno.test("dashboard shows the activity sidebar when the comment relay is configured", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request("/", {
    headers: { cookie: await sessionCookie() },
  });
  const html = await res.text();
  assertStringIncludes(html, 'class="app-sidebar"');
  assertStringIncludes(html, "/api/sidebar-activity");
});

Deno.test("dashboard has no sidebar when the comment relay is not configured", async () => {
  const res = await makeApp(fakeGitHub()).request("/", {
    headers: { cookie: await sessionCookie() },
  });
  const html = await res.text();
  assertEquals(html.includes('class="app-sidebar"'), false);
});

Deno.test("GET /api/sidebar-activity redirects to login when logged out", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request(
    "/api/sidebar-activity",
    { redirect: "manual" },
  );
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/auth/login");
});

Deno.test("GET /api/sidebar-activity returns the grouped, rendered activity list", async () => {
  let receivedQuery: { authors: string[]; limit: number } | null = null;
  const grist = fakeGrist({
    listActivity: (q) => {
      receivedQuery = q;
      return Promise.resolve([
        {
          commentId: 1,
          repo: "dtinth/claw",
          issue: 5,
          author: "dtinth-claw[bot]",
          authorId: 1,
          body: "hi",
          time: 1709294400,
          url: "https://github.com/dtinth/claw/issues/5#issuecomment-1",
        },
      ]);
    },
  });
  const res = await makeApp(fakeGitHub(), { grist }).request("/api/sidebar-activity", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'href="/dtinth/claw/issues/5#issuecomment-1"');
  assertEquals(receivedQuery, { authors: ["dtinth-claw[bot]", "dtinth"], limit: 400 });
});

Deno.test("GET /api/sidebar-activity returns 503 when the relay is not configured", async () => {
  const res = await makeApp(fakeGitHub()).request("/api/sidebar-activity", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 503);
});

Deno.test("a session for a different login is not accepted", async () => {
  const res = await makeApp(fakeGitHub()).request("/", {
    headers: { cookie: await sessionCookie("someone-else") },
  });
  assertStringIncludes(await res.text(), "/auth/login");
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
  const jwt = await createClawJwt(
    { repo: "dtinth/claw", permissions: { contents: "read", issues: "write" }, ttlSeconds: 3600 },
    config.jwtSecret,
  );
  const res = await makeApp(github).request("/api/token", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.token, "ghs_scopedtoken");
  assertEquals(body.repository, "dtinth/claw");
  assertEquals(calledWith, { repo: "dtinth/claw", perms: { contents: "read", issues: "write" } });
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
  const jwt = await createClawJwt(
    { repo: "dtinth/claw", permissions: { contents: "read" }, ttlSeconds: 3600, label: "agent-x" },
    config.jwtSecret,
  );
  const grant = await verifyClawJwt(jwt, config.jwtSecret);

  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    const res = await makeApp(github).request("/api/token", {
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

Deno.test("POST /api/token rejects a missing token with 401", async () => {
  const res = await makeApp(fakeGitHub()).request("/api/token", { method: "POST" });
  assertEquals(res.status, 401);
});

Deno.test("POST /api/token rejects an invalid token with 401", async () => {
  const res = await makeApp(fakeGitHub()).request("/api/token", {
    method: "POST",
    headers: { authorization: "Bearer not.a.jwt" },
  });
  assertEquals(res.status, 401);
});

Deno.test("POST /jwt mints a claw JWT from the dashboard form", async () => {
  const form = new URLSearchParams({
    repo: "dtinth/claw",
    lifetime_amount: "30",
    lifetime_unit: "days",
    "perm_contents": "read",
    "perm_issues": "write",
    label: "my agent",
  });
  const res = await makeApp(fakeGitHub()).request("/jwt", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "eyJ"); // a JWT
  assertStringIncludes(html, 'id="jwt-copy"'); // copy-to-clipboard button
  assertStringIncludes(html, "readonly"); // truncated, not editable
});

Deno.test("POST /jwt redirects to login when logged out", async () => {
  const res = await makeApp(fakeGitHub()).request("/jwt", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "repo=dtinth/claw",
    redirect: "manual",
  });
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/auth/login");
});

// --- prefilled comment drafts ----------------------------------------------

Deno.test("GET /draft redirects to login when logged out", async () => {
  const res = await makeApp(fakeGitHub()).request("/draft?repo=dtinth/claw&issue=5&body=hi", {
    redirect: "manual",
  });
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/auth/login");
});

Deno.test("GET /draft renders a prefilled, escaped form when logged in", async () => {
  const res = await makeApp(fakeGitHub()).request(
    "/draft?repo=dtinth/claw&issue=5&body=" + encodeURIComponent("Body <script>x</script>"),
    { headers: { cookie: await sessionCookie() } },
  );
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "dtinth/claw");
  assertStringIncludes(html, "issue #5");
  assertStringIncludes(html, "&lt;script&gt;"); // body escaped, not executed
  assertStringIncludes(html, "Post as me");
});

Deno.test("GET /draft shows the sidebar too — it's app-shell chrome, not dashboard-only", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request(
    "/draft?repo=dtinth/claw&issue=5",
    { headers: { cookie: await sessionCookie() } },
  );
  assertStringIncludes(await res.text(), 'class="app-sidebar"');
});

Deno.test("GET /draft includes client-side draft-persistence script keyed to this thread", async () => {
  const res = await makeApp(fakeGitHub()).request(
    "/draft?repo=dtinth/claw&issue=5",
    { headers: { cookie: await sessionCookie() } },
  );
  const html = await res.text();
  assertStringIncludes(html, "localStorage");
  assertStringIncludes(html, "claw-draft:dtinth/claw:issue:5:");
});

Deno.test("GET /draft returns 400 on invalid params", async () => {
  const res = await makeApp(fakeGitHub()).request("/draft?body=hi", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /draft refreshes an about-to-expire token before posting", async () => {
  let refreshedWith: string | null = null;
  let postedToken: string | null = null;
  const github = fakeGitHub({
    refreshUserToken: (rt) => {
      refreshedWith = rt;
      return Promise.resolve({
        accessToken: "ghu_fresh",
        refreshToken: "ghr_next",
        expiresInSeconds: 28800,
      });
    },
    postIssueComment: (token) => {
      postedToken = token;
      return Promise.resolve({ htmlUrl: "https://github.com/dtinth/claw/issues/5#issuecomment-1" });
    },
  });
  // session with a refresh token and an already-expired access token
  const cookie = await encodeSession(
    {
      login: "dtinth",
      accessToken: "ghu_stale",
      refreshToken: "ghr_old",
      accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date().toISOString(),
    },
    config.jwtSecret,
    3600,
  );
  const form = new URLSearchParams({ repo: "dtinth/claw", kind: "issue", number: "5", body: "hi" });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: {
      cookie: `claw_session=${cookie}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  assertEquals(res.status, 200);
  assertEquals(refreshedWith, "ghr_old");
  assertEquals(postedToken, "ghu_fresh"); // posted with the refreshed token
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "claw_session="); // re-issued
});

Deno.test("POST /draft posts an issue comment as the user", async () => {
  let posted: { token: string; repo: string; n: number; body: string } | null = null;
  const github = fakeGitHub({
    postIssueComment: (token, repo, n, body) => {
      posted = { token, repo, n, body };
      return Promise.resolve({ htmlUrl: "https://github.com/dtinth/claw/issues/5#issuecomment-1" });
    },
  });
  const form = new URLSearchParams({
    repo: "dtinth/claw",
    kind: "issue",
    number: "5",
    body: "Thanks for the report!",
  });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "Posted");
  assertEquals(posted, {
    token: "ghu_usertoken",
    repo: "dtinth/claw",
    n: 5,
    body: "Thanks for the report!",
  });
});

Deno.test("POST /draft's success page links to claw's own comment feed for an issue", async () => {
  const github = fakeGitHub({
    postIssueComment: () =>
      Promise.resolve({ htmlUrl: "https://github.com/dtinth/claw/issues/5#issuecomment-1" }),
  });
  const form = new URLSearchParams({ repo: "dtinth/claw", kind: "issue", number: "5", body: "hi" });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const html = await res.text();
  assertStringIncludes(html, 'href="/dtinth/claw/issues/5"');
  assertStringIncludes(html, "localStorage.removeItem"); // clears the persisted draft on success
});

Deno.test("POST /draft's success page has no comment-feed link for a discussion (not relayed)", async () => {
  const github = fakeGitHub({
    postDiscussionComment: () =>
      Promise.resolve({ url: "https://github.com/dtinth/claw/discussions/5#discussioncomment-1" }),
  });
  const form = new URLSearchParams({
    repo: "dtinth/claw",
    kind: "discussion",
    number: "5",
    body: "hi",
  });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const html = await res.text();
  assertEquals(html.includes("comment feed"), false);
});

Deno.test("POST /draft prompts re-login (not 502) when the GitHub token expired", async () => {
  const github = fakeGitHub({
    postIssueComment: () => {
      throw new GitHubApiError(401, "Bad credentials");
    },
  });
  const form = new URLSearchParams({ repo: "dtinth/claw", kind: "issue", number: "5", body: "hi" });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  // Not 502/504 — those get masked by Cloudflare's own error page.
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "session has expired");
  assertStringIncludes(html, "/auth/login");
  // the session cookie is cleared
  assertStringIncludes(res.headers.get("set-cookie") ?? "", "claw_session=");
});

Deno.test("POST /draft shows a readable error (not 502) on a generic post failure", async () => {
  const github = fakeGitHub({
    postIssueComment: () => {
      throw new GitHubApiError(422, "Validation failed");
    },
  });
  const form = new URLSearchParams({ repo: "dtinth/claw", kind: "issue", number: "5", body: "hi" });
  const res = await makeApp(github).request("/draft", {
    method: "POST",
    headers: { cookie: await sessionCookie(), "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "Validation failed");
});

Deno.test("POST /draft hints at app permissions and logs to stderr on 403", async () => {
  const github = fakeGitHub({
    postIssueComment: () => {
      throw new GitHubApiError(403, "Resource not accessible by integration");
    },
  });
  const form = new URLSearchParams({ repo: "dtinth/claw", kind: "issue", number: "1", body: "hi" });

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
  let html = "";
  try {
    const res = await makeApp(github).request("/draft", {
      method: "POST",
      headers: {
        cookie: await sessionCookie(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    assertEquals(res.status, 200);
    html = await res.text();
  } finally {
    console.error = original;
  }
  assertStringIncludes(html, "Resource not accessible by integration");
  assertStringIncludes(html, "Issues: Write"); // actionable hint
  // the error was written to stderr for the deploy console
  assertStringIncludes(errors.join("\n"), "failed to post comment to dtinth/claw");
});

// --- webhook + comment relay ------------------------------------------------

const ISSUE_COMMENT_PAYLOAD = {
  action: "created",
  issue: { number: 844 },
  comment: {
    id: 5015219517,
    body: "Is the bridge working?",
    user: { login: "dtinth", id: 193136 },
    created_at: "2024-03-01T12:00:00Z",
  },
  repository: { full_name: "bemusic/bemuse" },
};

Deno.test("POST /webhook verifies the signature and upserts a comment", async () => {
  let upserted: CommentRecord | null = null;
  const grist = fakeGrist({
    upsertComment: (rec) => {
      upserted = rec;
      return Promise.resolve();
    },
  });
  const body = JSON.stringify(ISSUE_COMMENT_PAYLOAD);
  const res = await makeApp(fakeGitHub(), { config: webhookConfig, grist }).request("/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": signBody(body),
    },
    body,
  });
  assertEquals(res.status, 202);
  assertEquals(upserted, {
    Comment_ID: 5015219517,
    Repo: "bemusic/bemuse",
    Issue: 844,
    User_ID: 193136,
    User_Name: "dtinth",
    Body: "Is the bridge working?",
    Time: 1709294400,
  });
});

Deno.test("POST /webhook rejects a bad signature with 401", async () => {
  const body = JSON.stringify(ISSUE_COMMENT_PAYLOAD);
  const res = await makeApp(fakeGitHub(), { config: webhookConfig, grist: fakeGrist() }).request(
    "/webhook",
    {
      method: "POST",
      headers: { "x-github-event": "issue_comment", "x-hub-signature-256": "sha256=deadbeef" },
      body,
    },
  );
  assertEquals(res.status, 401);
});

Deno.test("POST /webhook ignores non-comment events with 204", async () => {
  const body = JSON.stringify({ zen: "hi" });
  const res = await makeApp(fakeGitHub(), { config: webhookConfig, grist: fakeGrist() }).request(
    "/webhook",
    {
      method: "POST",
      headers: { "x-github-event": "ping", "x-hub-signature-256": signBody(body) },
      body,
    },
  );
  assertEquals(res.status, 204);
});

Deno.test("POST /webhook returns 503 when the relay is not configured", async () => {
  const res = await makeApp(fakeGitHub()).request("/webhook", { method: "POST", body: "{}" });
  assertEquals(res.status, 503);
});

Deno.test("GET /api/comments returns comments filtered by JWT repo, issue and authors", async () => {
  let receivedQuery: CommentQuery | null = null;
  const sample: Comment = {
    commentId: 1,
    repo: "bemusic/bemuse",
    issue: 844,
    author: "dtinth",
    authorId: 193136,
    body: "hello",
    url: "https://github.com/bemusic/bemuse/issues/844#issuecomment-1",
  };
  const grist = fakeGrist({
    queryComments: (q) => {
      receivedQuery = q;
      return Promise.resolve([sample]);
    },
  });
  const jwt = await createClawJwt(
    { repo: "bemusic/bemuse", permissions: { issues: "read" }, ttlSeconds: 3600 },
    config.jwtSecret,
  );
  const res = await makeApp(fakeGitHub(), { grist }).request(
    "/api/comments?issue=844&authors=dtinth,alice",
    { headers: { authorization: `Bearer ${jwt}` } },
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.comments, [sample]);
  assertEquals(receivedQuery, { repo: "bemusic/bemuse", issue: 844, authors: ["dtinth", "alice"] });
});

Deno.test("GET /api/comments rejects a missing token with 401", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request("/api/comments");
  assertEquals(res.status, 401);
});

Deno.test("GET /api/comments returns 503 when the relay is not configured", async () => {
  const jwt = await createClawJwt(
    { repo: "o/r", permissions: { issues: "read" }, ttlSeconds: 3600 },
    config.jwtSecret,
  );
  const res = await makeApp(fakeGitHub()).request("/api/comments", {
    headers: { authorization: `Bearer ${jwt}` },
  });
  assertEquals(res.status, 503);
});

// --- POST /api/upload -------------------------------------------------------

async function uploadJwt(repo = "o/r") {
  return await createClawJwt(
    { repo, permissions: { issues: "read" }, ttlSeconds: 3600 },
    config.jwtSecret,
  );
}

function uploadForm(filename: string, contents: string): FormData {
  const form = new FormData();
  form.set("file", new Blob([contents]), filename);
  return form;
}

Deno.test("POST /api/upload stores the file and returns the URL and CID", async () => {
  let received: { filename: string; data: Uint8Array } | null = null;
  const uploads = fakeUploads({
    upload: (data, filename) => {
      received = { filename, data };
      return Promise.resolve({
        cid: "bafy...",
        key: "ipfs/bafy.../hello.txt",
        url: "https://im.example.com/ipfs/bafy.../hello.txt",
      });
    },
  });
  const jwt = await uploadJwt();
  const res = await makeApp(fakeGitHub(), { uploads }).request("/api/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: uploadForm("hello.txt", "hello world"),
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { url: "https://im.example.com/ipfs/bafy.../hello.txt", cid: "bafy..." });
  assertEquals(received!.filename, "hello.txt");
  assertEquals(new TextDecoder().decode(received!.data), "hello world");
});

Deno.test("POST /api/upload rejects a missing token with 401", async () => {
  const res = await makeApp(fakeGitHub(), { uploads: fakeUploads() }).request("/api/upload", {
    method: "POST",
    body: uploadForm("hello.txt", "hello"),
  });
  assertEquals(res.status, 401);
});

Deno.test("POST /api/upload rejects an invalid token with 401", async () => {
  const res = await makeApp(fakeGitHub(), { uploads: fakeUploads() }).request("/api/upload", {
    method: "POST",
    headers: { authorization: "Bearer not-a-jwt" },
    body: uploadForm("hello.txt", "hello"),
  });
  assertEquals(res.status, 401);
});

Deno.test("POST /api/upload returns 503 when upload storage is not configured", async () => {
  const jwt = await uploadJwt();
  const res = await makeApp(fakeGitHub()).request("/api/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: uploadForm("hello.txt", "hello"),
  });
  assertEquals(res.status, 503);
});

Deno.test("POST /api/upload returns 400 when the file field is missing", async () => {
  const jwt = await uploadJwt();
  const res = await makeApp(fakeGitHub(), { uploads: fakeUploads() }).request("/api/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: new FormData(),
  });
  assertEquals(res.status, 400);
});

Deno.test("POST /api/upload returns 400 on an invalid filename", async () => {
  const uploads = fakeUploads({
    upload: () => {
      throw new InvalidFilenameError("filename must not contain a path separator: a/b.txt");
    },
  });
  const jwt = await uploadJwt();
  const res = await makeApp(fakeGitHub(), { uploads }).request("/api/upload", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body: uploadForm("a/b.txt", "hello"),
  });
  assertEquals(res.status, 400);
});

// --- GET /:owner/:repo/issues/:number (and /pull/:number) -------------------

const SAMPLE_ISSUE_COMMENT: Comment = {
  commentId: 1,
  repo: "dtinth/claw",
  issue: 24,
  author: "dtinth",
  authorId: 193136,
  body: "hello **world**",
  url: "https://github.com/dtinth/claw/issues/24#issuecomment-1",
};

Deno.test("GET /:owner/:repo/issues/:number redirects to login when logged out", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request(
    "/dtinth/claw/issues/24",
    { redirect: "manual" },
  );
  assertEquals(res.status, 302);
  assertEquals(res.headers.get("location"), "/auth/login");
});

Deno.test("GET /:owner/:repo/issues/:number renders the comment feed when logged in", async () => {
  let receivedQuery: CommentQuery | null = null;
  const grist = fakeGrist({
    queryComments: (q) => {
      receivedQuery = q;
      return Promise.resolve([SAMPLE_ISSUE_COMMENT]);
    },
  });
  const res = await makeApp(fakeGitHub(), { grist }).request("/dtinth/claw/issues/24", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "<strong>world</strong>"); // GFM-rendered
  assertStringIncludes(html, 'id="issuecomment-1"');
  assertEquals(receivedQuery, { repo: "dtinth/claw", issue: 24 });
});

Deno.test("GET /:owner/:repo/pull/:number uses the same handler as /issues/:number", async () => {
  const grist = fakeGrist({ queryComments: () => Promise.resolve([SAMPLE_ISSUE_COMMENT]) });
  const res = await makeApp(fakeGitHub(), { grist }).request("/dtinth/claw/pull/24", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), 'id="issuecomment-1"');
});

Deno.test("GET /:owner/:repo/issues/:number?partial=1 returns just the comment fragment", async () => {
  const grist = fakeGrist({ queryComments: () => Promise.resolve([SAMPLE_ISSUE_COMMENT]) });
  const res = await makeApp(fakeGitHub(), { grist }).request("/dtinth/claw/issues/24?partial=1", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, 'id="issuecomment-1"');
  assertEquals(html.includes("<!doctype html>"), false); // fragment, not a full page
});

Deno.test("GET /:owner/:repo/issues/:number returns 503 when the relay is not configured", async () => {
  const res = await makeApp(fakeGitHub()).request("/dtinth/claw/issues/24", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 503);
});

Deno.test("GET /:owner/:repo/issues/:number?partial=1 returns 503 when the relay is not configured", async () => {
  const res = await makeApp(fakeGitHub()).request("/dtinth/claw/issues/24?partial=1", {
    headers: { cookie: await sessionCookie() },
  });
  assertEquals(res.status, 503);
});

Deno.test("GET /:owner/:repo/issues/:number rejects a non-numeric issue number with 400", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request(
    "/dtinth/claw/issues/not-a-number",
    { headers: { cookie: await sessionCookie() } },
  );
  assertEquals(res.status, 400);
});

Deno.test("GET /:owner/:repo/issues/:number rejects an invalid owner/repo with 400", async () => {
  const res = await makeApp(fakeGitHub(), { grist: fakeGrist() }).request(
    "/weird!owner/claw/issues/24",
    { headers: { cookie: await sessionCookie() } },
  );
  assertEquals(res.status, 400);
});
