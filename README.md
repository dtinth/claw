# claw

A small server that gives your coding agents **fine-grained, time-boxed access
to your GitHub repositories** — and lets them draft comments for you to post,
rather than commenting as themselves.

claw is built around a GitHub App (in this deployment, **DTINTH-CLAW**) that is
installed on your repositories. Only you (`ALLOWED_LOGIN`, default `dtinth`) can
log in and take action.

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

An agent shouldn't comment on public issues as itself. Instead it submits a
**draft**, and you review and post it under your own GitHub identity (via the
app's user-to-server token):

```sh
curl -s -X POST https://claw.example.com/api/drafts \
  -H "Authorization: Bearer <a claw JWT>" \
  -H "content-type: application/json" \
  -d '{
    "repo": "owner/repo",
    "target": { "kind": "issue", "issueNumber": 42 },
    "body": "Thanks for the report — fixed in #45."
  }'
# => { "id": "…", "url": "https://claw.example.com/drafts/…" }
```

`target` is either `{ "kind": "issue", "issueNumber": N }` (issues and pull
requests) or `{ "kind": "discussion", "discussionNumber": N, "replyToId": "…" }`
(`replyToId` optional).

The agent hands you that URL. You open it, review the text, and click **Post as
me** — issues and pull requests go through the REST API, discussions through
GraphQL (`addDiscussionComment`, with optional `replyToId`).

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
| `DENO_KV_PATH` | — | Path to the Deno KV SQLite file. Default is Deno's location; the Docker image uses `/data/kv.sqlite`. |

### GitHub App setup

1. Create (or open) your GitHub App and note the **App ID** and **Client ID**,
   generate a **client secret**, and download a **private key**.
2. Under the app's permissions, grant the repository permissions you want to be
   able to delegate (contents, issues, pull requests, discussions, …). claw can
   only ever mint tokens for permissions the app itself holds.
3. Enable user-to-server auth and set the **Callback URL** to
   `${BASE_URL}/auth/callback`.
4. Install the app on the repositories you want to reach.

> **A note on PKCE:** GitHub's OAuth does not support PKCE. claw is a
> confidential client (it holds the client secret server-side), so it uses the
> standard authorization-code flow hardened with a `state` parameter and
> httpOnly session cookies — the equivalent protection PKCE gives public
> clients.

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

Deno KV persists to a local SQLite file. Mount a volume at `/data` (the image's
`DENO_KV_PATH`) to keep drafts and sessions across redeploys; without one they
are ephemeral and you simply log in again.

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
| `src/store.ts` | Deno KV persistence for drafts and sessions. |
| `src/github/` | Repo parsing, app JWT, and the GitHub API client. |
| `src/web/` | The Hono app, routes and server-rendered views. |
| `src/main.ts` | Wire everything together and serve. |
