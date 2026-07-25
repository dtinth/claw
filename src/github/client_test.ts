import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { generateKeyPairSync } from "node:crypto";
import { createGitHubClient, GitHubApiError } from "./client.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** Build a fake fetch that routes on `${METHOD} ${pathname}` and records calls. */
function fakeFetch(routes: Record<string, (req: Recorded) => Response>) {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const recorded: Recorded = { url, method, headers, body };
    calls.push(recorded);
    const key = `${method} ${new URL(url).pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return await Promise.resolve(handler(recorded));
  };
  return { fn, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch) {
  return createGitHubClient({
    appId: "123456",
    privateKeyPem: privateKey,
    clientId: "Iv1.client",
    clientSecret: "secret",
    fetch: fetchFn,
  });
}

Deno.test("mintRepoToken looks up the installation and mints a scoped token", async () => {
  const { fn, calls } = fakeFetch({
    "GET /repos/dtinth/claw/installation": () => json({ id: 42 }),
    "POST /app/installations/42/access_tokens": () =>
      json({
        token: "ghs_installationtoken",
        expires_at: "2026-07-20T01:00:00Z",
        permissions: { contents: "read", issues: "write" },
      }),
  });
  const client = makeClient(fn);

  const result = await client.mintRepoToken("dtinth/claw", {
    contents: "read",
    issues: "write",
  });

  assertEquals(result.token, "ghs_installationtoken");
  assertEquals(result.repository, "dtinth/claw");
  assertEquals(result.expiresAt, "2026-07-20T01:00:00Z");

  // The token request must scope to the single repo and pass permissions.
  const tokenCall = calls.find((c) => c.url.includes("access_tokens"))!;
  assertEquals((tokenCall.body as { repositories: string[] }).repositories, ["claw"]);
  assertEquals((tokenCall.body as { permissions: unknown }).permissions, {
    contents: "read",
    issues: "write",
  });
  // Both app calls are authenticated with a Bearer JWT (three dot-separated parts).
  const auth = tokenCall.headers.get("authorization") ?? "";
  assertStringIncludes(auth, "Bearer ");
  assertEquals(auth.slice("Bearer ".length).split(".").length, 3);
});

Deno.test("mintRepoToken throws GitHubApiError when the repo has no installation", async () => {
  const { fn } = fakeFetch({
    "GET /repos/dtinth/secret/installation": () => json({ message: "Not Found" }, 404),
  });
  const client = makeClient(fn);
  await assertRejects(
    () => client.mintRepoToken("dtinth/secret", { contents: "read" }),
    GitHubApiError,
    "404",
  );
});

Deno.test("buildAuthorizeUrl includes client_id, redirect_uri and state", () => {
  const client = makeClient(fetch);
  const url = new URL(
    client.buildAuthorizeUrl({
      state: "abc123",
      redirectUri: "https://claw.example.com/auth/callback",
    }),
  );
  assertEquals(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assertEquals(url.searchParams.get("client_id"), "Iv1.client");
  assertEquals(url.searchParams.get("state"), "abc123");
  assertEquals(url.searchParams.get("redirect_uri"), "https://claw.example.com/auth/callback");
});

Deno.test("buildAuthorizeUrl includes the PKCE challenge when provided", () => {
  const client = makeClient(fetch);
  const url = new URL(client.buildAuthorizeUrl({
    state: "s",
    redirectUri: "https://c/cb",
    codeChallenge: "the-challenge",
  }));
  assertEquals(url.searchParams.get("code_challenge"), "the-challenge");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
});

Deno.test("buildAuthorizeUrl includes the OAuth scope when provided", () => {
  const client = makeClient(fetch);
  const url = new URL(client.buildAuthorizeUrl({
    state: "s",
    redirectUri: "https://c/cb",
    scopes: "public_repo",
  }));
  assertEquals(url.searchParams.get("scope"), "public_repo");
});

Deno.test("refreshUserToken exchanges a refresh token for a fresh token", async () => {
  const { fn, calls } = fakeFetch({
    "POST /login/oauth/access_token": () =>
      json({ access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 }),
  });
  const client = makeClient(fn);
  const token = await client.refreshUserToken("ghr_old");
  assertEquals(token.accessToken, "ghu_new");
  assertEquals(token.refreshToken, "ghr_new");
  const body = calls[0]!.body as { grant_type: string; refresh_token: string };
  assertEquals(body.grant_type, "refresh_token");
  assertEquals(body.refresh_token, "ghr_old");
});

Deno.test("exchangeCode forwards the PKCE code_verifier", async () => {
  const { fn, calls } = fakeFetch({
    "POST /login/oauth/access_token": () => json({ access_token: "ghu_x" }),
  });
  const client = makeClient(fn);
  await client.exchangeCode({
    code: "c",
    redirectUri: "https://c/cb",
    codeVerifier: "the-verifier",
  });
  assertEquals((calls[0]!.body as { code_verifier: string }).code_verifier, "the-verifier");
});

Deno.test("exchangeCode returns the user token", async () => {
  const { fn, calls } = fakeFetch({
    "POST /login/oauth/access_token": () =>
      json({ access_token: "ghu_usertoken", refresh_token: "ghr_refresh", expires_in: 28800 }),
  });
  const client = makeClient(fn);
  const token = await client.exchangeCode({
    code: "thecode",
    redirectUri: "https://claw.example.com/auth/callback",
  });
  assertEquals(token.accessToken, "ghu_usertoken");
  assertEquals(token.refreshToken, "ghr_refresh");
  assertEquals(token.expiresInSeconds, 28800);
  assertEquals((calls[0]!.body as { code: string }).code, "thecode");
});

Deno.test("exchangeCode surfaces an OAuth error", async () => {
  const { fn } = fakeFetch({
    "POST /login/oauth/access_token": () =>
      json({ error: "bad_verification_code", error_description: "expired" }),
  });
  const client = makeClient(fn);
  await assertRejects(
    () => client.exchangeCode({ code: "x", redirectUri: "https://c/cb" }),
    GitHubApiError,
    "bad_verification_code",
  );
});

Deno.test("getAuthenticatedUser returns the login", async () => {
  const { fn, calls } = fakeFetch({
    "GET /user": () => json({ login: "dtinth", id: 193136 }),
  });
  const client = makeClient(fn);
  const user = await client.getAuthenticatedUser("ghu_usertoken");
  assertEquals(user.login, "dtinth");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer ghu_usertoken");
});

Deno.test("postIssueComment posts as the user and returns the html url", async () => {
  const { fn, calls } = fakeFetch({
    "POST /repos/dtinth/claw/issues/7/comments": () =>
      json({
        html_url: "https://github.com/dtinth/claw/issues/7#issuecomment-1",
        id: 1,
        created_at: "2024-03-01T12:00:00Z",
        user: { id: 193136, login: "dtinth" },
      }, 201),
  });
  const client = makeClient(fn);
  const result = await client.postIssueComment("ghu_x", "dtinth/claw", 7, "Thanks!");
  assertEquals(result.htmlUrl, "https://github.com/dtinth/claw/issues/7#issuecomment-1");
  assertEquals((calls[0]!.body as { body: string }).body, "Thanks!");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer ghu_x");
});

Deno.test("postIssueComment also returns enough to upsert into Grist without waiting for the webhook", async () => {
  const { fn } = fakeFetch({
    "POST /repos/dtinth/claw/issues/7/comments": () =>
      json({
        html_url: "https://github.com/dtinth/claw/issues/7#issuecomment-1",
        id: 1,
        created_at: "2024-03-01T12:00:00Z",
        user: { id: 193136, login: "dtinth" },
      }, 201),
  });
  const client = makeClient(fn);
  const result = await client.postIssueComment("ghu_x", "dtinth/claw", 7, "Thanks!");
  assertEquals(result.commentId, 1);
  assertEquals(result.userId, 193136);
  assertEquals(result.userLogin, "dtinth");
  assertEquals(result.createdAt, "2024-03-01T12:00:00Z");
});

Deno.test("postDiscussionComment resolves the discussion id then mutates", async () => {
  let graphqlCalls = 0;
  const { fn } = fakeFetch({
    "POST /graphql": (req) => {
      graphqlCalls++;
      const query = (req.body as { query: string }).query;
      if (query.includes("discussion(")) {
        return json({ data: { repository: { discussion: { id: "D_kwDO123" } } } });
      }
      return json({
        data: {
          addDiscussionComment: {
            comment: { url: "https://github.com/dtinth/claw/discussions/3#discussioncomment-9" },
          },
        },
      });
    },
  });
  const client = makeClient(fn);
  const result = await client.postDiscussionComment("ghu_x", "dtinth/claw", 3, "Great idea");
  assertEquals(result.url, "https://github.com/dtinth/claw/discussions/3#discussioncomment-9");
  assertEquals(graphqlCalls, 2);
});
