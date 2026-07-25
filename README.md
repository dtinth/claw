# claw

A command center for my agentic open source contributions.

![claw's dashboard, open on an iPad — a sidebar showing Claude usage meters and recent bot activity next to a comment feed](https://im.dt.in.th/ipfs/bafybeihabthjsoevcrqx2r4gdgkhucql332xy6dczpllrytiis34ifmqdm/ipad.png)

claw is built around a GitHub App (in this deployment, **dtinth/claw**) that is
installed on my repositories, and gives my coding agents **fine-grained,
time-boxed access** to them.

## My guidelines for open source contributions with a coding agent

I mostly communicate with my coding agent **publicly, on GitHub issues** — see
[#5](https://github.com/dtinth/claw/issues/5) on this very repo for what that
looks like in practice. The agent posts under its own identity
(`dtinth-claw[bot]`), so it's always clear which comments and commits are
AI-generated.

On **other people's repos**, the agent never opens a PR or comments directly —
it only works on my personal fork and talks to me. I relay to upstream
maintainers myself: the agent's draft is usually a starting point — talking
points I rewrite in my own voice, though sometimes I do post it close to
as-is — but I review and post everything myself. The exception is projects I
lead myself — there I install `dtinth-claw[bot]` directly on the repo, e.g.
[creatorsgarten/contentsgarten#464](https://github.com/creatorsgarten/contentsgarten/issues/464)
and [bemusic/bemuse#844](https://github.com/bemusic/bemuse/issues/844).

## What it does

claw is three things working together.

### The web dashboard

The control center where I monitor my agents' activity and chat with them
publicly on GitHub.

- A sidebar shows the issues my agents are currently working on.
- It also shows my Claude subscription's usage meters, each with a small
  **pacemaker** figure comparing how much of the usage window has elapsed
  against how much of the limit is already used:
  - **Positive** — a comfortable buffer at the current pace.
  - **Negative** — a warning: usage is outpacing the clock and will hit the
    limit before it resets unless the pace eases up.
- A comment feed that's less janky than GitHub's own UI, so I can keep up
  with a conversation and reply to my agent more efficiently.

### The access token broker

Lets me grant each coding agent fine-grained access to specific
repositories while every agent shares the same GitHub identity.

- An agent requests a token from claw; claw mints a GitHub App installation
  token (~1 hour lifetime) scoped to just that repo and just those
  permissions, so every action any agent takes is scoped and auditable.
- Agents also need to notice new comments quickly, so claw runs a local
  database (built on [Grist](https://www.getgrist.com/)) fed by a GitHub
  webhook. New comments land there the moment they're posted, so agents
  poll claw's local copy instead of polling GitHub directly — staying
  responsive while remaining a well-behaved GitHub API citizen.

### The CLI

The piece of code my coding agent actually runs, to talk to the token
broker and the comment relay (see [Agent CLI](#agent-cli) below).

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
your own GitHub identity (the app's user-to-server token). Whatever you type is
mirrored to `localStorage` as you go (like GitHub's own comment box) and
restored if you come back to the same link — cleared once the post actually
succeeds, kept if it fails. `⌘`/`Ctrl`+`Enter` submits from the textarea.
Posting to an issue also links to claw's own comment feed (feature 5) for
that issue, not just the GitHub URL.

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
`Issue`, `User_ID`, `User_Name`, `Body`, `Time` (the comment's `created_at`, as
an epoch-seconds integer — Grist's own expected format for a Date/DateTime
column). This feature is optional — without `GITHUB_WEBHOOK_SECRET` and the
`GRIST_*` variables, `/webhook` and `/api/comments` return `503` and the rest
of claw runs unaffected.

### 4. File uploads to public, IPFS-addressed storage

GitHub's API has no way to attach a file to a comment the way the web UI's
drag-and-drop does — so an agent that wants to post a screenshot or a log
needs somewhere else to put it first. `POST /api/upload` (same claw JWT,
multipart `file` field) stores the file in S3-compatible storage under
`ipfs/<cid>/<filename>`, where `<cid>` is the file's IPFS content identifier
(computed with [`@thai/carify`](https://jsr.io/@thai/carify), the same
unixfs/CAR logic [`dtinth/upload-server`](https://github.com/dtinth/upload-server)
uses). Same file + same filename always hashes to the same CID, so the
returned URL also works from any IPFS gateway if the file is ever pinned
there.

```sh
curl -s -X POST https://claw.example.com/api/upload \
  -H "Authorization: Bearer <a claw JWT>" \
  -F file=@screenshot.png
# => { "url": "https://im.example.com/ipfs/bafy.../screenshot.png", "cid": "bafy..." }
```

Any repo's claw JWT can upload (this isn't a GitHub permission — the file
never touches GitHub, so there's nothing in `PERMISSION_CATALOG` to grant).
Optional — without the `UPLOAD_STORAGE_*` variables, `/api/upload` returns
`503` and the rest of claw runs unaffected.

### 5. Live, Grist-backed issue/PR comment view

`GET /<owner>/<repo>/issues/<number>` (and `/pull/<number>`, same thing) —
same path shape as GitHub's own issue/PR URLs, so a real GitHub link works
here by just swapping the hostname. Logged-in only. It's a read of the
comment relay (feature 3), not a live GitHub API call: each comment is
rendered as sanitized GitHub-flavored markdown ([`@deno/gfm`](https://jsr.io/@deno/gfm),
safe against embedded `<script>`/event-handler XSS by default) with a link
back to the real comment on GitHub and, if the relayed row has a `Time`
value, its timestamp (older rows written before that column existed just
don't show one). Only the last 5 comments show expanded; anything earlier
sits behind a native `<details>` "Show N earlier comments" toggle (a direct
link to an older comment, e.g. from the sidebar, force-opens it and jumps
straight there — no smooth-scroll animation). The page polls itself every
~10s (a small `?partial=1` fragment request, preserving the toggle's
open/closed state across refreshes) so new comments show up without a
reload, and a "Jump to latest ↓" link at the top scrolls to a marker just
past the last comment. It's read-only — reply via `/draft`, linked from
both the top and the bottom of the thread.

### 6. Dashboard sidebar: recent bot activity

Every logged-in page shows a sticky left sidebar (part of the shared page
shell, not just the dashboard) listing the issues/PRs the coding-agent bot
(`dtinth-claw[bot]`, hardcoded — not an env var yet) has most recently
commented on, across every repo the relay has seen — grouped to one entry
per issue, newest first, relative timestamps, linking straight to that
comment on feature 5's comment feed. Its data loads asynchronously
(`GET /api/sidebar-activity`, session-gated) so it never blocks the rest of
the page, and it polls itself every 15s while its tab is visible. A small
`«`/`»` toggle collapses it to a slim rail (state remembered in
`localStorage`, so it stays collapsed/expanded across page loads).

If a bot comment `@`-mentions you, the entry's excerpt starts at that
mention and is shown prominently (an orange accent, bold text) — unless
you've since posted a newer comment on the same issue, in which case it's
treated as already handled and shown like any other entry. Visiting the
comment feed for that issue also marks it read, client-side
(`localStorage`, key `claw-read:<repo>#<issue>`) — the mention stops
looking prominent, replaced with a small ↺ icon next to the issue number to
undo it. Requires the comment relay (feature 3) to be configured; absent
otherwise.

## Configuration

All configuration comes from environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `GITHUB_APP_ID` | ✅ | The GitHub App's numeric id. |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | The app private key (PEM). Escaped `\n` or base64 is accepted. |
| `GITHUB_CLIENT_ID` | ✅ | OAuth client id used for your browser login (see the login note below). |
| `GITHUB_CLIENT_SECRET` | ✅ | OAuth client secret for the login. |
| `GITHUB_OAUTH_SCOPES` | — | OAuth scopes requested at login. Default `public_repo`. Set empty for a GitHub App login. |
| `CLAW_JWT_SECRET` | ✅ | Secret used to sign intermediary claw JWTs (HS256). |
| `BASE_URL` | ✅ | Public base URL, e.g. `https://claw.example.com`. |
| `ALLOWED_LOGIN` | — | The single GitHub login allowed to use claw. Default `dtinth`. |
| `PORT` | — | Port to listen on. Default `8000`. |
| `GITHUB_WEBHOOK_SECRET` | — | Webhook secret for `/webhook`. Enables the comment relay together with the `GRIST_*` vars. |
| `GRIST_API_URL` | — | Grist base API URL including the document id, e.g. `https://grist.example.com/api/docs/<docId>`. |
| `GRIST_API_KEY` | — | Grist API key (sent as a bearer token). Required when `GRIST_API_URL` is set. |
| `GRIST_TABLE_ID` | — | Grist table name. Default `Comments`. |
| `UPLOAD_STORAGE_ENDPOINT` | — | S3-compatible endpoint URL, e.g. `https://s3.example.com`. Enables `/api/upload` together with the rest of the `UPLOAD_STORAGE_*` vars. |
| `UPLOAD_STORAGE_BUCKET` | — | Bucket name. Required when `UPLOAD_STORAGE_ENDPOINT` is set. |
| `UPLOAD_STORAGE_ACCESS_KEY_ID` | — | Access key id. Required when `UPLOAD_STORAGE_ENDPOINT` is set. |
| `UPLOAD_STORAGE_SECRET_ACCESS_KEY` | — | Secret access key. Required when `UPLOAD_STORAGE_ENDPOINT` is set. |
| `UPLOAD_STORAGE_REGION` | — | Region, e.g. `us-east-1`. Required when `UPLOAD_STORAGE_ENDPOINT` is set. |
| `UPLOAD_STORAGE_PUBLIC_URL` | — | Public base URL uploaded files are readable at, e.g. `https://im.example.com`. Required when `UPLOAD_STORAGE_ENDPOINT` is set. |

### GitHub App setup

1. Create (or open) your GitHub App and note the **App ID** and **Client ID**,
   generate a **client secret**, and download a **private key**.
2. Under the app's permissions, grant the repository permissions you want to be
   able to delegate (contents, issues, pull requests, discussions, …). claw can
   only ever mint tokens for permissions the app itself holds.
3. Enable user-to-server auth and set the **Callback URL** to
   `${BASE_URL}/auth/callback`.
4. Install the app on the repositories you want to reach.

> **Which login: OAuth App or GitHub App?** The token broker (feature 1) always
> uses the **GitHub App** — it needs the app private key, and `GITHUB_CLIENT_ID`/
> `GITHUB_CLIENT_SECRET` are used *only* for your browser login. For the comment
> feature, that login determines where you can post:
>
> - **OAuth App** (recommended, the default) — put an OAuth App's client id/secret
>   in those vars. With `GITHUB_OAUTH_SCOPES=public_repo` (the default) you can
>   comment on **any public repo**, because OAuth tokens are scope-based, not
>   installation-based.
> - **GitHub App user-to-server** — reuse the GitHub App's OAuth credentials and
>   set `GITHUB_OAUTH_SCOPES=` (empty). Least-privilege, but you can then only
>   comment on repos where the app is **installed** (i.e. your own).
>
> claw refreshes the user token automatically when it is about to expire (GitHub
> App user tokens expire ~8h; OAuth App tokens usually don't), falling back to a
> re-login prompt if the refresh fails.

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

## Agent CLI

[`agent/`](agent) is a standalone Deno CLI for the machine on the *other* end
of a claw JWT — a coding agent that needs `gh`/`git` to work against a repo
without ever touching the app's private key. It's a separate project (its own
`deno.json`, no import from `src/`) so the two halves can't accidentally share
secrets.

```sh
cd agent
deno task compile   # -> ./claw
ln -sf "$PWD/claw" ~/.local/bin/claw   # put it on PATH; re-run compile after any code change
```

Set up once per repo you want to delegate to an agent: mint a claw JWT from
the web UI, then hand it to `claw grant` — it decodes the token's own
repository claim, so there's nothing else to specify:

```sh
claw grant   # paste the JWT when prompted, or: claw grant <jwt>
```

This writes `~/.config/claw/grants.json` (`{"owner/repo": "<jwt>"}`), adding
to or updating whatever's already there. Then, per machine:

```sh
export CLAW_BASE_URL=https://claw.example.com
claw setup   # point git's github.com credential helper at `gh auth git-credential`
claw doctor  # sanity-check config, grants and the git wiring
```

`claw setup` doesn't touch `gh`'s own login state — it only rewires git's
credential helper to read whatever `GH_TOKEN` is in the environment when
invoked. From then on:

```sh
claw token                        # print a token for the repo (--repo, $CLAW_REPO, or git origin)
claw exec -- gh pr create …       # run a command with GH_TOKEN + CLAW_REPO set
claw exec -- git push
```

`exec` mints a token (or reuses a cached one with >5 minutes left) and sets it
as `GH_TOKEN` for the child process only — `gh` reads it directly, and git
picks it up through the credential helper `setup` installed. Tokens are
scoped to the single repo the JWT names, so wrap the command, not a whole
shell session: `GH_TOKEN` is a snapshot and doesn't renew mid-session.

### Watching for comments

`claw monitor <issue>` polls the comment relay (feature 3 above) for one
issue/PR and prints each new comment as a single JSON line — a jsonl stream
meant to feed a long-running watcher (e.g. Claude Code's `Monitor` tool,
which treats each stdout line as an event):

```sh
claw monitor 24                          # poll dtinth/claw#24 every 10s (default)
claw monitor 24 --interval 30            # slower polling
claw monitor 24 --authors dtinth         # only comments from these logins
```

Unlike `token`/`exec`, this doesn't mint an installation token — `/api/comments`
accepts the claw JWT directly, so `monitor` just reads it straight from the
grants file. Status and errors go to stderr only, never stdout, so the jsonl
stream stays clean; a transient failure (network blip, 5xx) is logged and
retried, never crashes the process, but an invalid/expired JWT (401) or a
relay that isn't configured on the server (503) exits — those won't fix
themselves by retrying.

`monitor` is stateless: the first poll of a run emits every comment already
there (you just started watching, you want the context), and later polls in
that same run only emit new arrivals — but nothing is written to disk, so a
restart re-emits the current backlog rather than resuming from where it left
off.

### Uploading a file

`claw upload <path>` uploads a local file to public, IPFS-addressed storage
(feature 4 above) and prints the resulting URL — for attaching a screenshot,
log, or build artifact to a GitHub comment, which GitHub's API has no direct
way to do:

```sh
claw upload screenshot.png                    # generic default: "image.png"
claw upload notes.txt                         # generic default: "file.txt"
claw upload screenshot.png --keep-filename     # keeps "screenshot.png"
claw upload screenshot.png --filename foo.png  # explicit rename
```

By default the uploaded filename is a generic `image.ext`/`file.ext` (image
extensions get `image`, everything else gets `file`) rather than the local
name — the object key already has the content's CID as a path segment
(`ipfs/<cid>/<filename>`), so the filename itself doesn't need to be unique,
just a sensible extension. `--keep-filename` and `--filename` are mutually
exclusive. Like `monitor`, this authenticates with the claw JWT directly, no
installation token minted.

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
| `src/storage/` | CID calculation, S3-compatible storage, and the `/api/upload` orchestration. |
| `src/web/` | The Hono app, routes and server-rendered views. |
| `src/main.ts` | Wire everything together and serve. |
| `agent/` | The standalone agent CLI (`claw token`/`exec`/`monitor`/`upload`/`setup`/`doctor`); its own `deno.json`, no import from `src/`. |
