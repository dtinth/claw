# claw

A small server that gives my coding agents **fine-grained, time-boxed access
to your GitHub repositories** — and lets them draft comments for me to post,
rather than commenting as themselves.

claw is built around a GitHub App (in this deployment, **dtinth/claw**) that is
installed on my repositories.

## What it does

### 1. Repository-scoped installation tokens, on demand

GitHub App installation tokens are coarse (they cover everything the app can
reach) and short-lived (~1 hour). claw turns that into something you can safely
hand an agent:

1. You log in and **mint an intermediary "claw JWT"**, choosing a repository, a
   set of permissions, and a lifetime (e.g. 30 days).
2. You give that JWT to a coding agent.
3. The agent calls `POST /api/token` with the JWT. claw verifies it, then uses
   the app's private key to mint a **GitHub installation token scoped to just
   that repository, with just those permissions**, and returns it.
4. The agent re-requests whenever its ~1h token expires. The long-lived
   credential the agent holds is the claw JWT, never the app's private key.

```sh
curl -s -X POST https://claw.example.com/api/token \
  -H "Authorization: Bearer <your claw JWT>"
# => { "token": "ghs_…", "expires_at": "…", "repository": "owner/repo", "permissions": { … } }
```

### 2. Comment drafts you post yourself

An agent shouldn't comment on public issues as itself. Instead it hands you a
**prefilled link** — no API call, nothing stored:

```
https://claw.example.com/draft?repo=owner/repo&issue=42&body=Thanks%20—%20fixed%20in%20%2345
```

You open it (logged in), see an **editable, prefilled comment form**, tweak the
text if you like, and click **Post as me**. Issues and pull requests go through
the REST API; use `discussion=N` (with optional `replyTo=<node-id>`) instead of
`issue=N` for a discussion comment via GraphQL. The comment is published under
your own GitHub identity (the app's user-to-server token).

### 3. Comment relay via webhooks + Grist

So an agent can *listen* for your GitHub comments without polling GitHub, claw
ingests webhooks and mirrors comments into a Grist table; the agent then polls
claw. Configure the GitHub App webhook to `POST ${BASE_URL}/webhook` with a
secret matching `GITHUB_WEBHOOK_SECRET`.

- **Ingest** — `POST /webhook`: the signature (`X-Hub-Signature-256`) is
  verified, and `issue_comment` events (issues and pull requests) are upserted
  into Grist keyed by the GitHub comment id.
- **Poll** — `GET /api/comments` (same claw JWT): returns the relayed comments
  for the JWT's repository, optionally filtered by issue and author.

```sh
curl -s "https://claw.example.com/api/comments?issue=42&authors=dtinth" \
  -H "Authorization: Bearer <a claw JWT>"
# => { "comments": [ { "commentId": …, "issue": 42, "author": "dtinth", "body": "…", "url": "…" } ] }
```

The `Comments` table columns claw writes: `Comment_ID` (the upsert key), `Repo`,
`Issue`, `User_ID`, `User_Name`, `Body`. This feature is optional — without
`GITHUB_WEBHOOK_SECRET` and the `GRIST_*` variables, `/webhook` and
`/api/comments` return `503` and the rest of claw runs unaffected.

## Configuration

All configuration comes from environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | ✅ | The GitHub App's numeric id. |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | The app private key (PEM). Escaped `\n` or base64 is accepted. |
| `GITHUB_CLIENT_ID` | ✅ | The app's OAuth client id. |
| `GITHUB_CLIENT_SECRET` | ✅ | The app's OAuth client secret. |
| `CLAW_JWT_SECRET` | ✅ | Secret used to sign intermediary claw JWTs (HS256). |
| `BASE_URL` | ✅ | Public base URL, e.g. `https://claw.example.com`. |
| `ALLOWED_LOGIN` | — | The single GitHub login allowed to use claw. Default `dtinth`. |
| `PORT` | — | Port to listen on. Default `8000`. |
| `GITHUB_WEBHOOK_SECRET` | — | Webhook secret for `/webhook`. Enables the comment relay together with the `GRIST_*` vars. |
| `GRIST_API_URL` | — | Grist base API URL including the document id, e.g. `https://grist.example.com/api/docs/<docId>`. |
| `GRIST_API_KEY` | — | Grist API key (sent as a bearer token). Required when `GRIST_API_URL` is set. |
| `GRIST_TABLE_ID` | — | Grist table name. Default `Comments`. |

### GitHub App setup

1. Create (or open) your GitHub App and note the **App ID** and **Client ID**,
   generate a **client secret**, and download a **private key**.
2. Under the app's permissions, grant the repository permissions you want to be
   able to delegate (contents, issues, pull requests, discussions, …). claw can
   only ever mint tokens for permissions the app itself holds.
3. Enable user-to-server auth and set the **Callback URL** to
   `${BASE_URL}/auth/callback`.
4. Install the app on the repositories you want to reach.

> **A note on PKCE:** GitHub supports PKCE (S256) for OAuth and GitHub App
> authentication, but still requires the `client_secret` at the token exchange
> and does not send CORS headers on the token endpoint — so a pure browser-only
> flow isn't possible. claw is therefore a confidential, server-side client: it
> performs the code exchange itself and keeps the user token in an httpOnly
> session (never exposed to page JavaScript). It uses PKCE (`code_challenge` on
> the authorize request, `code_verifier` at exchange) together with a `state`
> parameter as defense-in-depth against code interception and CSRF.

## Running locally

```sh
export GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY="$(cat key.pem)" \
       GITHUB_CLIENT_ID=… GITHUB_CLIENT_SECRET=… \
       CLAW_JWT_SECRET=… BASE_URL=http://localhost:8000
deno task start
```

## Deployment

The repository ships a [`Dockerfile`](Dockerfile). Any platform that builds and
runs a Docker image works; pushing to `main` triggers a deploy in this setup.

claw is **stateless** — no database, no volume. Your browser session lives in an
encrypted cookie (3-day expiry, so you re-authenticate every few days), comment
drafts are just prefilled links, and relayed comments live in Grist. Redeploy
freely; the only thing lost is your login cookie's validity.

## Development

Built with [Deno](https://deno.com/) 2.x and [Hono](https://hono.dev/).
Everything is developed test-first; GitHub network calls sit behind an
injectable client so the whole app is tested in-process.

```sh
deno task test    # run the test suite
deno task check   # type-check
deno task ci      # fmt --check + lint + check + test (what CI runs)
```

### Layout

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Load and validate configuration from the environment. |
| `src/permissions.ts` | The delegatable permission catalog and validation. |
| `src/jwt.ts` | Mint and verify intermediary claw JWTs. |
| `src/session.ts` | Encrypted (JWE) stateless session cookie. |
| `src/draft.ts` | Parse prefilled comment-draft links. |
| `src/pkce.ts` | PKCE verifier/challenge helpers. |
| `src/github/` | Repo parsing, app JWT, and the GitHub API client. |
| `src/web/` | The Hono app, routes and server-rendered views. |
| `src/main.ts` | Wire everything together and serve. |
