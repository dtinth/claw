/**
 * claw's HTTP surface, built on Hono. Fully stateless — no server-side store.
 *
 * Two audiences:
 *  - **You, via the browser** — an encrypted (JWE) session cookie holds the
 *    GitHub user token (GitHub App user-to-server OAuth, PKCE). Mint claw JWTs;
 *    open prefilled comment-draft links and post them as yourself.
 *  - **Coding agents, via the API** — bearer claw JWT. Exchange it for a
 *    repo-scoped installation token; poll relayed comments.
 *
 * All dependencies are injected so the whole app is testable with
 * `app.request()` and fakes.
 */
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.ts";
import { decodeSession, encodeSession, type Session } from "../session.ts";
import { GitHubApiError, type GitHubClient } from "../github/client.ts";
import { formatRepo, parseRepo, RepoParseError } from "../github/repo.ts";
import type { CommentQuery, GristClient } from "../grist/client.ts";
import { issuePage, renderCommentsHtml } from "./comment_feed.ts";
import { InvalidFilenameError, type UploadService } from "../storage/upload.ts";
import { parseIssueCommentEvent, verifyWebhookSignature } from "../webhook.ts";
import { type ClawGrant, ClawJwtError, createClawJwt, verifyClawJwt } from "../jwt.ts";
import { type DraftInput, type DraftTarget, parseDraftParams } from "../draft.ts";
import {
  formatPermissions,
  isEmptyPermissions,
  parsePermissions,
  PERMISSION_CATALOG,
  type Permissions,
} from "../permissions.ts";
import { codeChallenge, generateCodeVerifier } from "../pkce.ts";
import { escapeHtml, jsonForScript, layout } from "./html.ts";

const SESSION_COOKIE = "claw_session";
const STATE_COOKIE = "claw_oauth_state";
const VERIFIER_COOKIE = "claw_oauth_verifier";
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days — you re-authenticate after.

/** Dependencies for the app. */
export interface AppDeps {
  config: Config;
  github: GitHubClient;
  /** Optional Grist client enabling the webhook relay and comment polling. */
  grist?: GristClient;
  /** Optional upload service enabling `/api/upload`. */
  uploads?: UploadService;
}

type Variables = { session: Session };

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createApp(deps: AppDeps) {
  const { config, github, grist, uploads } = deps;
  const secure = config.baseUrl.startsWith("https://");
  const redirectUri = `${config.baseUrl}/auth/callback`;

  const app = new Hono<{ Variables: Variables }>();

  // Safety net: log any uncaught handler error to stderr and return a plain
  // 500 (never 502/504, which Cloudflare masks with its own page).
  app.onError((err, c) => {
    console.error(`claw: unhandled error on ${c.req.method} ${new URL(c.req.url).pathname}`, err);
    return c.json({ error: "internal server error" }, 500);
  });

  // --- helpers ------------------------------------------------------------

  async function currentSession(c: Context<{ Variables: Variables }>) {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (!cookie) return null;
    const session = await decodeSession(cookie, config.jwtSecret);
    if (!session || session.login !== config.allowedLogin) return null;
    return session;
  }

  // Guard for browser routes: resolve the session once, redirect to login if
  // absent, and expose it to handlers via c.get("session").
  const requireSession = async (
    c: Context<{ Variables: Variables }>,
    next: () => Promise<void>,
  ) => {
    const session = await currentSession(c);
    if (!session) return c.redirect("/auth/login");
    c.set("session", session);
    await next();
  };
  app.use("/jwt", requireSession);
  app.use("/draft", requireSession);
  app.use("/:owner/:repo/issues/:number", requireSession);
  app.use("/:owner/:repo/pull/:number", requireSession);

  async function setSessionCookie(c: Context<{ Variables: Variables }>, session: Session) {
    const cookie = await encodeSession(session, config.jwtSecret, SESSION_TTL_SECONDS);
    setCookie(c, SESSION_COOKIE, cookie, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  }

  // Refresh the GitHub user token if it is about to expire and we hold a
  // refresh token (GitHub App user tokens expire ~8h; OAuth App tokens usually
  // don't, in which case this is a no-op). Re-issues the session cookie.
  async function refreshIfNeeded(
    c: Context<{ Variables: Variables }>,
    session: Session,
  ): Promise<Session> {
    if (!session.refreshToken || !session.accessTokenExpiresAt) return session;
    const expiresMs = Date.parse(session.accessTokenExpiresAt);
    if (Number.isNaN(expiresMs) || expiresMs - Date.now() > 60_000) return session;
    try {
      const refreshed = await github.refreshUserToken(session.refreshToken);
      const next: Session = {
        login: session.login,
        accessToken: refreshed.accessToken,
        createdAt: session.createdAt,
      };
      if (refreshed.refreshToken) next.refreshToken = refreshed.refreshToken;
      if (refreshed.expiresInSeconds !== undefined) {
        next.accessTokenExpiresAt = new Date(Date.now() + refreshed.expiresInSeconds * 1000)
          .toISOString();
      }
      await setSessionCookie(c, next);
      return next;
    } catch (error) {
      console.error("claw: token refresh failed", error);
      return session; // fall through; a GitHub 401 will then prompt re-login
    }
  }

  // --- health -------------------------------------------------------------

  app.get("/healthz", (c) => c.text("ok"));

  // --- home / dashboard ---------------------------------------------------

  app.get("/", async (c) => {
    const session = await currentSession(c);
    if (!session) {
      return c.html(layout(
        "claw",
        `<p class="muted">Fine-grained GitHub access for your coding agents.</p>
         <p><a href="/auth/login"><button>Log in with GitHub</button></a></p>`,
      ));
    }
    return c.html(
      layout("claw — dashboard", dashboard(session, config.allowedLogin, config.baseUrl)),
    );
  });

  // --- auth ---------------------------------------------------------------

  app.get("/auth/login", async (c) => {
    const state = randomToken();
    const verifier = generateCodeVerifier();
    const challenge = await codeChallenge(verifier);
    const cookieOpts = { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: 600 } as const;
    setCookie(c, STATE_COOKIE, state, cookieOpts);
    setCookie(c, VERIFIER_COOKIE, verifier, cookieOpts);
    return c.redirect(
      github.buildAuthorizeUrl({
        state,
        redirectUri,
        codeChallenge: challenge,
        scopes: config.oauthScopes,
      }),
    );
  });

  app.get("/auth/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    const verifier = getCookie(c, VERIFIER_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    deleteCookie(c, VERIFIER_COOKIE, { path: "/" });

    if (!code || !state || !expectedState || state !== expectedState || !verifier) {
      return c.html(
        layout(
          "claw — login failed",
          errorBlock("Invalid or expired login attempt. Please try again."),
        ),
        400,
      );
    }

    let user: { login: string };
    let token;
    try {
      token = await github.exchangeCode({ code, redirectUri, codeVerifier: verifier });
      user = await github.getAuthenticatedUser(token.accessToken);
    } catch (error) {
      console.error("claw: OAuth callback failed", error);
      return c.html(
        layout(
          "claw — login failed",
          errorBlock(error instanceof Error ? error.message : String(error)),
        ),
        // Not 502/504 — Cloudflare would replace the body with its own page.
        200,
      );
    }

    if (user.login !== config.allowedLogin) {
      return c.html(
        layout(
          "claw — access denied",
          errorBlock(
            `Only @${config.allowedLogin} may use this instance (you are @${user.login}).`,
          ),
        ),
        403,
      );
    }

    const session: Session = {
      login: user.login,
      accessToken: token.accessToken,
      createdAt: new Date().toISOString(),
    };
    if (token.refreshToken) session.refreshToken = token.refreshToken;
    if (token.expiresInSeconds !== undefined) {
      session.accessTokenExpiresAt = new Date(Date.now() + token.expiresInSeconds * 1000)
        .toISOString();
    }

    await setSessionCookie(c, session);
    return c.redirect("/");
  });

  app.post("/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/");
  });

  // --- mint a claw JWT (browser, session-authenticated) -------------------

  app.post("/jwt", async (c) => {
    const form = await c.req.parseBody();
    const repo = String(form.repo ?? "").trim();
    const amount = Number(form.lifetime_amount ?? "0");
    const unit = String(form.lifetime_unit ?? "days");
    const label = String(form.label ?? "").trim();

    const rawPerms: Record<string, string> = {};
    for (const name of Object.keys(PERMISSION_CATALOG)) {
      const value = form[`perm_${name}`];
      if (typeof value === "string") rawPerms[name] = value;
    }

    try {
      // createClawJwt is the authoritative gate for repo and lifetime; here we
      // only decode the form shape (unit → seconds) and give a friendlier
      // message for the empty-permissions case.
      const permissions = parsePermissions(rawPerms);
      if (isEmptyPermissions(permissions)) {
        throw new Error(
          "select at least one permission (otherwise the token would have full app access)",
        );
      }
      const unitSeconds = unit === "minutes" ? 60 : unit === "hours" ? 3600 : 86400;
      const ttlSeconds = Math.round(amount * unitSeconds);
      const params: Parameters<typeof createClawJwt>[0] = { repo, permissions, ttlSeconds };
      if (label) params.label = label;
      const jwt = await createClawJwt(params, config.jwtSecret);
      return c.html(
        layout(
          "claw — token minted",
          mintedTokenPage(jwt, repo, permissions, ttlSeconds, config.baseUrl),
        ),
      );
    } catch (error) {
      return c.html(
        layout(
          "claw — mint failed",
          errorBlock(error instanceof Error ? error.message : String(error)) + backLink(),
        ),
        400,
      );
    }
  });

  // --- agent API: exchange claw JWT for an installation token -------------

  app.post("/api/token", async (c) => {
    const jwt = bearer(c.req.header("authorization"));
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    try {
      const grant = await verifyClawJwt(jwt, config.jwtSecret);
      const token = await github.mintRepoToken(grant.repo, grant.permissions);
      // Audit log: there is no revocation list, so every exchange is recorded
      // (by jti) to the console for after-the-fact traceability.
      console.log(formatExchangeLog(grant, token.expiresAt));
      return c.json({
        token: token.token,
        expires_at: token.expiresAt,
        repository: token.repository,
        permissions: token.permissions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`claw token-exchange rejected: ${message}`);
      if (error instanceof ClawJwtError) {
        return c.json({ error: error.message }, 401);
      }
      // 500 not 502: Cloudflare masks origin 502/504 with its own error page.
      return c.json({ error: message }, 500);
    }
  });

  // --- incoming GitHub webhook: relay comments into Grist -----------------

  app.post("/webhook", async (c) => {
    if (!config.webhookSecret || !grist) {
      return c.json({ error: "webhook relay is not configured" }, 503);
    }
    const raw = await c.req.text();
    if (
      !verifyWebhookSignature(
        config.webhookSecret,
        raw,
        c.req.header("x-hub-signature-256") ?? null,
      )
    ) {
      return c.json({ error: "invalid signature" }, 401);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const record = parseIssueCommentEvent(c.req.header("x-github-event") ?? "", payload);
    if (!record) return c.body(null, 204); // not a comment we relay

    try {
      await grist.upsertComment(record);
    } catch (error) {
      console.warn(
        `claw webhook upsert failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return c.json({ error: "failed to store comment" }, 500);
    }
    return c.json({ ok: true, comment_id: record.Comment_ID }, 202);
  });

  // --- agent API: poll relayed comments for the JWT's repo ----------------

  app.get("/api/comments", async (c) => {
    const jwt = bearer(c.req.header("authorization"));
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    let grant;
    try {
      grant = await verifyClawJwt(jwt, config.jwtSecret);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 401);
    }
    if (!grist) return c.json({ error: "comment relay is not configured" }, 503);

    // Repo is fixed to the JWT's scope; issue and authors are optional filters.
    const query: CommentQuery = { repo: grant.repo };
    const issueParam = c.req.query("issue");
    if (issueParam) {
      const n = Number(issueParam);
      if (!Number.isInteger(n) || n <= 0) {
        return c.json({ error: "issue must be a positive integer" }, 400);
      }
      query.issue = n;
    }
    const authorsParam = c.req.query("authors");
    if (authorsParam) {
      const authors = authorsParam.split(",").map((a) => a.trim()).filter(Boolean);
      if (authors.length > 0) query.authors = authors;
    }

    try {
      return c.json({ comments: await grist.queryComments(query) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // --- agent API: upload a file to public, IPFS-addressed storage ---------

  app.post("/api/upload", async (c) => {
    const jwt = bearer(c.req.header("authorization"));
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    try {
      await verifyClawJwt(jwt, config.jwtSecret);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 401);
    }
    if (!uploads) return c.json({ error: "upload storage is not configured" }, 503);

    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      return c.json({ error: 'multipart field "file" is required' }, 400);
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const result = await uploads.upload(data, file.name);
      return c.json({ url: result.url, cid: result.cid });
    } catch (error) {
      if (error instanceof InvalidFilenameError) {
        return c.json({ error: error.message }, 400);
      }
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // --- browser: live Grist-backed comment feed for one issue/PR ----------
  //
  // Same path shape as GitHub's own issue/PR URLs (so a real GitHub link can
  // be reused by just swapping the hostname), and comment anchors match
  // GitHub's `#issuecomment-<id>` scheme too. Grist-only — no GitHub API call.

  async function issueFeedHandler(c: Context<{ Variables: Variables }>) {
    let repo: string;
    try {
      repo = formatRepo(parseRepo(`${c.req.param("owner")}/${c.req.param("repo")}`));
    } catch (error) {
      const message = error instanceof RepoParseError ? error.message : "invalid repository";
      return c.html(layout("claw — not found", errorBlock(message) + backLink()), 400);
    }
    const issue = Number(c.req.param("number"));
    if (!Number.isInteger(issue) || issue <= 0) {
      return c.html(
        layout(
          "claw — not found",
          errorBlock("issue/PR number must be a positive integer") + backLink(),
        ),
        400,
      );
    }
    const partial = c.req.query("partial") !== undefined;
    if (!grist) {
      const message = "comment relay is not configured";
      return partial
        ? c.text(message, 503)
        : c.html(layout("claw — not configured", errorBlock(message) + backLink()), 503);
    }

    const comments = await grist.queryComments({ repo, issue });
    const commentsHtml = renderCommentsHtml(comments);
    if (partial) return c.html(commentsHtml);
    return c.html(layout(`claw — ${repo}#${issue}`, issuePage({ repo, issue, commentsHtml })));
  }
  app.get("/:owner/:repo/issues/:number", issueFeedHandler);
  app.get("/:owner/:repo/pull/:number", issueFeedHandler);

  // --- browser: prefilled comment draft (stateless, from query params) ----

  app.get("/draft", (c) => {
    const parsed = parseDraftParams(new URL(c.req.url).searchParams);
    if ("error" in parsed) {
      return c.html(layout("claw — draft", errorBlock(parsed.error) + backLink()), 400);
    }
    return c.html(layout("claw — new comment", draftFormPage(parsed.value)));
  });

  app.post("/draft", async (c) => {
    const session = await refreshIfNeeded(c, c.get("session"));
    const form = await c.req.parseBody();
    const parsed = parseDraftParams(formToParams(form));
    if ("error" in parsed) {
      return c.html(layout("claw — draft", errorBlock(parsed.error) + backLink()), 400);
    }
    const { repo, target, body } = parsed.value;
    if (body.trim() === "") {
      return c.html(
        layout("claw — draft", errorBlock("comment body must not be empty") + backLink()),
        400,
      );
    }

    try {
      let postedUrl: string;
      if (target.kind === "issue") {
        postedUrl = (await github.postIssueComment(
          session.accessToken,
          repo,
          target.issueNumber,
          body,
        )).htmlUrl;
      } else {
        postedUrl = (await github.postDiscussionComment(
          session.accessToken,
          repo,
          target.discussionNumber,
          body,
          target.replyToId,
        )).url;
      }
      return c.html(layout("claw — posted", postedPage(postedUrl, repo, target)));
    } catch (error) {
      console.error(`claw: failed to post comment to ${repo} (${target.kind})`, error);
      // A GitHub 401 almost always means the user-to-server token has expired
      // (GitHub Apps expire them ~8h by default). Clear the session and prompt
      // a fresh login rather than surfacing a raw error.
      if (error instanceof GitHubApiError && error.status === 401) {
        deleteCookie(c, SESSION_COOKIE, { path: "/" });
        return c.html(
          layout(
            "claw — session expired",
            errorBlock("Your GitHub session has expired. Log in again, then retry the post.") +
              `<p><a href="/auth/login"><button>Log in with GitHub</button></a></p>`,
          ),
          // NB: not 502/504 — Cloudflare replaces those bodies with its own page.
          200,
        );
      }
      let message = error instanceof Error ? error.message : String(error);
      // "Resource not accessible by integration" = the GitHub App lacks the
      // permission for this action even though the token is yours.
      if (error instanceof GitHubApiError && error.status === 403) {
        message +=
          ' — the GitHub App is likely missing "Issues: Write" (or "Discussions: Write") permission. ' +
          "Grant it in the app settings, re-authorize the new permission, then log in again.";
      }
      return c.html(
        layout("claw — post failed", errorBlock(message) + backLink()),
        200,
      );
    }
  });

  return app;
}

// --- input parsing ---------------------------------------------------------

function formatExchangeLog(grant: ClawGrant, installationExpires: string): string {
  return [
    "claw token-exchange",
    `jti=${grant.jti}`,
    `repo=${grant.repo}`,
    `label=${JSON.stringify(grant.label)}`,
    `permissions=${formatPermissions(grant.permissions)}`,
    `jwt_expires=${grant.expiresAt.toISOString()}`,
    `installation_expires=${installationExpires}`,
    `at=${new Date().toISOString()}`,
  ].join(" ");
}

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/** Map a posted draft form back to the query shape parseDraftParams expects. */
function formToParams(form: Record<string, unknown>): URLSearchParams {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const params = new URLSearchParams();
  params.set("repo", str(form.repo));
  params.set("body", str(form.body));
  if (str(form.kind) === "discussion") {
    params.set("discussion", str(form.number));
    if (str(form.replyTo)) params.set("replyTo", str(form.replyTo));
  } else {
    params.set("issue", str(form.number));
  }
  return params;
}

// --- views -----------------------------------------------------------------

function errorBlock(message: string): string {
  return `<div class="card"><strong class="warn">Error:</strong> ${escapeHtml(message)}</div>`;
}

function backLink(href = "/"): string {
  return `<p><a href="${escapeHtml(href)}">← Back</a></p>`;
}

function targetLabel(target: DraftTarget): string {
  return target.kind === "issue"
    ? `issue #${target.issueNumber}`
    : `discussion #${target.discussionNumber}${
      target.replyToId ? ` (reply to ${escapeHtml(target.replyToId)})` : ""
    }`;
}

function permissionSelects(): string {
  return Object.entries(PERMISSION_CATALOG).map(([name, levels]) => {
    const options = ["none", ...levels]
      .map((lvl) => `<option value="${lvl === "none" ? "" : lvl}">${lvl}</option>`)
      .join("");
    return `<label for="perm_${name}">${escapeHtml(name)}</label>
      <select id="perm_${name}" name="perm_${name}">${options}</select>`;
  }).join("\n");
}

/**
 * One-click permission presets for the mint form. Each fills the dropdowns and
 * remains fully editable afterwards. Keys must be names in PERMISSION_CATALOG.
 */
const PERMISSION_PRESETS = [
  {
    id: "readonly",
    label: "Read-only",
    perms: { contents: "read", issues: "read", pull_requests: "read" },
  },
  {
    id: "agent",
    label: "Coding agent",
    perms: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      workflows: "write",
      checks: "read",
      statuses: "read",
      actions: "write",
    },
  },
  { id: "issues-prs", label: "Issues & PRs", perms: { issues: "write", pull_requests: "write" } },
  { id: "clear", label: "Clear", perms: {} },
] as const;

function permissionPresetButtons(): string {
  return PERMISSION_PRESETS.map((p) =>
    `<button type="button" class="preset" data-claw-preset="${p.id}">${
      escapeHtml(p.label)
    }</button>`
  ).join("");
}

/** Inline script that applies a preset to the permission selects on click. */
function permissionPresetScript(): string {
  const map = Object.fromEntries(PERMISSION_PRESETS.map((p) => [p.id, p.perms]));
  return `<script>
(function () {
  var presets = ${JSON.stringify(map)};
  document.querySelectorAll("[data-claw-preset]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var preset = presets[btn.getAttribute("data-claw-preset")] || {};
      document.querySelectorAll('select[name^="perm_"]').forEach(function (sel) {
        sel.value = preset[sel.name.slice(5)] || "";
      });
    });
  });
})();
</script>`;
}

function dashboard(session: Session, allowedLogin: string, baseUrl: string): string {
  return `
  <p>Signed in as <strong>@${escapeHtml(session.login)}</strong>.
    <form class="inline" method="post" action="/auth/logout"><button class="secondary">Log out</button></form>
  </p>

  <fieldset>
    <legend><strong>Mint an intermediary JWT</strong></legend>
    <form method="post" action="/jwt">
      <label for="repo">Repository (owner/repo)</label>
      <input id="repo" type="text" name="repo" placeholder="${
    escapeHtml(allowedLogin)
  }/some-repo" required>

      <div class="row">
        <div>
          <label for="lifetime_amount">Lifetime</label>
          <input id="lifetime_amount" type="number" name="lifetime_amount" value="30" min="1" step="1" required>
        </div>
        <div>
          <label for="lifetime_unit">Unit</label>
          <select id="lifetime_unit" name="lifetime_unit">
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days" selected>days</option>
          </select>
        </div>
      </div>

      <label>Permissions</label>
      <p class="muted" style="margin:.2rem 0">Presets fill the dropdowns — tweak after:</p>
      <div class="preset-row">${permissionPresetButtons()}</div>
      <div class="grid">${permissionSelects()}</div>

      <label for="label">Label (optional)</label>
      <input id="label" type="text" name="label" placeholder="which agent is this for?">

      <p><button type="submit">Mint JWT</button></p>
    </form>
  </fieldset>

  <h2>Comment drafts</h2>
  <p class="muted">An agent proposes a comment by handing you a link like
    <code>${escapeHtml(baseUrl)}/draft?repo=owner/repo&amp;issue=42&amp;body=…</code>.
    Open it to review, edit, and post the comment as yourself.</p>
  ${permissionPresetScript()}`;
}

function mintedTokenPage(
  jwt: string,
  repo: string,
  permissions: Permissions,
  ttlSeconds: number,
  baseUrl: string,
): string {
  const perms = formatPermissions(permissions);
  const days = (ttlSeconds / 86400).toFixed(2);
  return `
  <div class="card">
    <p class="ok"><strong>JWT minted</strong> for <code>${escapeHtml(repo)}</code>
      (${escapeHtml(perms)}), valid ~${escapeHtml(days)} days.</p>
    <p>Hand this to your coding agent. It never expires early and cannot be recovered later — copy it now.</p>
    <div class="copy-row">
      <input id="jwt-value" type="text" readonly value="${escapeHtml(jwt)}"
        onclick="this.select()" onfocus="this.select()">
      <button type="button" id="jwt-copy">Copy</button>
    </div>
  </div>
  <h3>How the agent uses it</h3>
  <pre>curl -s -X POST ${escapeHtml(baseUrl)}/api/token \\
  -H "Authorization: Bearer &lt;the JWT above&gt;"</pre>
  <p>Returns a GitHub installation token scoped to <code>${
    escapeHtml(repo)
  }</code>, valid ~1 hour. Re-request as needed.</p>
  ${backLink()}
  <script>
(function () {
  var btn = document.getElementById("jwt-copy");
  var input = document.getElementById("jwt-value");
  if (!btn || !input) return;
  btn.addEventListener("click", function () {
    var reset = function () {
      btn.textContent = "Copy";
    };
    navigator.clipboard.writeText(input.value).then(function () {
      btn.textContent = "Copied!";
      setTimeout(reset, 1500);
    }, function () {
      input.select();
      document.execCommand("copy");
      btn.textContent = "Copied!";
      setTimeout(reset, 1500);
    });
  });
})();
  </script>`;
}

/**
 * A stable key per draft target, for the client-side "remember what I was
 * typing" localStorage persistence — same idea as GitHub's own comment-box
 * draft recovery.
 */
function draftStorageKey(repo: string, target: DraftTarget): string {
  const number = target.kind === "issue" ? target.issueNumber : target.discussionNumber;
  const replyTo = target.kind === "discussion" ? target.replyToId ?? "" : "";
  return `claw-draft:${repo}:${target.kind}:${number}:${replyTo}`;
}

function draftFormPage(draft: DraftInput): string {
  const { repo, target, body } = draft;
  const number = target.kind === "issue" ? target.issueNumber : target.discussionNumber;
  const replyTo = target.kind === "discussion" && target.replyToId ? target.replyToId : "";
  return `
  <div class="card">
    <p>Prefilled comment for <strong>${escapeHtml(repo)}</strong> · ${targetLabel(target)}.</p>
    <p class="muted">Edit if you like, then post. This is published under <em>your</em> GitHub identity.</p>
  </div>
  <form method="post" action="/draft">
    <input type="hidden" name="repo" value="${escapeHtml(repo)}">
    <input type="hidden" name="kind" value="${escapeHtml(target.kind)}">
    <input type="hidden" name="number" value="${escapeHtml(String(number))}">
    <input type="hidden" name="replyTo" value="${escapeHtml(replyTo)}">
    <label for="body">Comment</label>
    <textarea id="body" name="body" required>${escapeHtml(body)}</textarea>
    <p><button type="submit">Post as me</button></p>
  </form>
  ${backLink()}
  <script>
(function () {
  var key = ${jsonForScript(draftStorageKey(repo, target))};
  var textarea = document.getElementById("body");
  try {
    if (!textarea.value) {
      var saved = localStorage.getItem(key);
      if (saved) textarea.value = saved;
    }
    textarea.addEventListener("input", function () {
      try {
        if (textarea.value) localStorage.setItem(key, textarea.value);
        else localStorage.removeItem(key);
      } catch (e) {}
    });
  } catch (e) {}
})();
  </script>`;
}

function postedPage(postedUrl: string, repo: string, target: DraftTarget): string {
  const viewerLink = target.kind === "issue"
    ? `<p><a href="/${
      escapeHtml(repo)
    }/issues/${target.issueNumber}">View in claw's comment feed →</a></p>`
    : "";
  return `
  <div class="card">
    <p class="ok"><strong>Posted</strong> to ${escapeHtml(repo)} · ${targetLabel(target)}.
      <a href="${escapeHtml(postedUrl)}">View comment on GitHub →</a></p>
    ${viewerLink}
  </div>
  ${backLink()}
  <script>
(function () {
  try { localStorage.removeItem(${jsonForScript(draftStorageKey(repo, target))}); } catch (e) {}
})();
  </script>`;
}
