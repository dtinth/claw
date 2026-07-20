/**
 * claw's HTTP surface, built on Hono.
 *
 * Two audiences:
 *  - **You (dtinth), via the browser** — cookie session (GitHub user-to-server
 *    OAuth). Mint intermediary JWTs; review and post drafted comments.
 *  - **Coding agents, via the API** — bearer claw JWT. Exchange it for a
 *    repo-scoped installation token; submit comment drafts for your review.
 *
 * All dependencies are injected so the whole app is testable with
 * `app.request()` and fakes.
 */
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Config } from "../config.ts";
import type { Session, Store } from "../store.ts";
import type { GitHubClient } from "../github/client.ts";
import type { CommentQuery, GristClient } from "../grist/client.ts";
import { parseIssueCommentEvent, verifyWebhookSignature } from "../webhook.ts";
import { type ClawGrant, ClawJwtError, createClawJwt, verifyClawJwt } from "../jwt.ts";
import { parseRepo } from "../github/repo.ts";
import {
  formatPermissions,
  isEmptyPermissions,
  parsePermissions,
  PERMISSION_CATALOG,
  type Permissions,
} from "../permissions.ts";
import { escapeHtml, layout } from "./html.ts";

const SESSION_COOKIE = "claw_session";
const STATE_COOKIE = "claw_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Dependencies for the app. */
export interface AppDeps {
  config: Config;
  store: Store;
  github: GitHubClient;
  /** Optional Grist client enabling the webhook relay and comment polling. */
  grist?: GristClient;
}

type Variables = { session: Session };

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createApp(deps: AppDeps) {
  const { config, store, github, grist } = deps;
  const secure = config.baseUrl.startsWith("https://");
  const redirectUri = `${config.baseUrl}/auth/callback`;

  const app = new Hono<{ Variables: Variables }>();

  // --- helpers ------------------------------------------------------------

  async function currentSession(c: Context<{ Variables: Variables }>) {
    const id = getCookie(c, SESSION_COOKIE);
    if (!id) return null;
    const session = await store.getSession(id);
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
  app.use("/drafts/*", requireSession);

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
    const drafts = await store.listDrafts(20);
    return c.html(layout("claw — dashboard", dashboard(session, drafts, config.allowedLogin)));
  });

  // --- auth ---------------------------------------------------------------

  app.get("/auth/login", (c) => {
    const state = randomToken();
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    return c.redirect(github.buildAuthorizeUrl({ state, redirectUri }));
  });

  app.get("/auth/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/" });

    if (!code || !state || !expectedState || state !== expectedState) {
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
      token = await github.exchangeCode({ code, redirectUri });
      user = await github.getAuthenticatedUser(token.accessToken);
    } catch (error) {
      return c.html(
        layout(
          "claw — login failed",
          errorBlock(error instanceof Error ? error.message : String(error)),
        ),
        502,
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

    const sessionId = randomToken();
    await store.putSession(sessionId, session, SESSION_TTL_MS);
    setCookie(c, SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.redirect("/");
  });

  app.post("/auth/logout", async (c) => {
    const id = getCookie(c, SESSION_COOKIE);
    if (id) await store.deleteSession(id);
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
      return c.json({ error: message }, 502);
    }
  });

  // --- agent API: submit a comment draft ----------------------------------

  app.post("/api/drafts", async (c) => {
    const jwt = bearer(c.req.header("authorization"));
    if (!jwt) return c.json({ error: "missing bearer token" }, 401);
    try {
      await verifyClawJwt(jwt, config.jwtSecret);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 401);
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = parseDraftInput(payload);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const draft = await store.createDraft(parsed.value);
    return c.json({ id: draft.id, url: `${config.baseUrl}/drafts/${draft.id}` }, 201);
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
      return c.json({ error: "failed to store comment" }, 502);
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
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // --- browser: review + post a draft -------------------------------------

  app.get("/drafts/:id", async (c) => {
    const draft = await store.getDraft(c.req.param("id"));
    if (!draft) return c.html(layout("claw — not found", errorBlock("Draft not found.")), 404);
    return c.html(layout("claw — review draft", draftPage(draft, config.baseUrl)));
  });

  app.post("/drafts/:id/post", async (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    const draft = await store.getDraft(id);
    if (!draft) return c.html(layout("claw — not found", errorBlock("Draft not found.")), 404);
    if (draft.status !== "pending") return c.redirect(`/drafts/${id}`);

    try {
      let url: string;
      if (draft.target.kind === "issue") {
        const result = await github.postIssueComment(
          session.accessToken,
          draft.repo,
          draft.target.issueNumber,
          draft.body,
        );
        url = result.htmlUrl;
      } else {
        const result = await github.postDiscussionComment(
          session.accessToken,
          draft.repo,
          draft.target.discussionNumber,
          draft.body,
          draft.target.replyToId,
        );
        url = result.url;
      }
      await store.updateDraft(id, {
        status: "posted",
        postedUrl: url,
        postedAt: new Date().toISOString(),
      });
      return c.redirect(`/drafts/${id}`);
    } catch (error) {
      return c.html(
        layout(
          "claw — post failed",
          errorBlock(error instanceof Error ? error.message : String(error)) +
            backLink(`/drafts/${id}`),
        ),
        502,
      );
    }
  });

  app.post("/drafts/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    const draft = await store.getDraft(id);
    if (draft && draft.status === "pending") {
      await store.updateDraft(id, { status: "dismissed" });
    }
    return c.redirect(`/drafts/${id}`);
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

function parseDraftInput(
  payload: unknown,
): { value: { repo: string; target: import("../store.ts").DraftTarget; body: string } } | {
  error: string;
} {
  if (payload === null || typeof payload !== "object") return { error: "body must be an object" };
  const obj = payload as Record<string, unknown>;

  const repo = typeof obj.repo === "string" ? obj.repo.trim() : "";
  try {
    parseRepo(repo);
  } catch {
    return { error: "repo must be a valid owner/repo" };
  }

  const body = typeof obj.body === "string" ? obj.body : "";
  if (body.trim() === "") return { error: "body must not be empty" };

  const target = obj.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") return { error: "target is required" };

  if (target.kind === "issue") {
    const n = Number(target.issueNumber);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "target.issueNumber must be a positive integer" };
    }
    return { value: { repo, body, target: { kind: "issue", issueNumber: n } } };
  }
  if (target.kind === "discussion") {
    const n = Number(target.discussionNumber);
    if (!Number.isInteger(n) || n <= 0) {
      return { error: "target.discussionNumber must be a positive integer" };
    }
    const t: import("../store.ts").DraftTarget = { kind: "discussion", discussionNumber: n };
    if (typeof target.replyToId === "string" && target.replyToId) t.replyToId = target.replyToId;
    return { value: { repo, body, target: t } };
  }
  return { error: 'target.kind must be "issue" or "discussion"' };
}

// --- views -----------------------------------------------------------------

function errorBlock(message: string): string {
  return `<div class="card"><strong class="warn">Error:</strong> ${escapeHtml(message)}</div>`;
}

function backLink(href = "/"): string {
  return `<p><a href="${escapeHtml(href)}">← Back</a></p>`;
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

function dashboard(
  session: Session,
  drafts: import("../store.ts").Draft[],
  allowedLogin: string,
): string {
  const draftRows = drafts.length === 0
    ? `<tr><td colspan="3" class="muted">No drafts yet.</td></tr>`
    : drafts.map((d) => {
      const target = d.target.kind === "issue"
        ? `issue #${d.target.issueNumber}`
        : `discussion #${d.target.discussionNumber}`;
      return `<tr>
        <td><a href="/drafts/${escapeHtml(d.id)}">${escapeHtml(d.repo)} · ${target}</a></td>
        <td>${escapeHtml(d.status)}</td>
        <td class="muted">${escapeHtml(d.createdAt)}</td>
      </tr>`;
    }).join("\n");

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
      <div class="grid">${permissionSelects()}</div>

      <label for="label">Label (optional)</label>
      <input id="label" type="text" name="label" placeholder="which agent is this for?">

      <p><button type="submit">Mint JWT</button></p>
    </form>
  </fieldset>

  <h2>Recent drafts</h2>
  <table>
    <thead><tr><th>Target</th><th>Status</th><th>Created</th></tr></thead>
    <tbody>${draftRows}</tbody>
  </table>`;
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
    <pre>${escapeHtml(jwt)}</pre>
  </div>
  <h3>How the agent uses it</h3>
  <pre>curl -s -X POST ${escapeHtml(baseUrl)}/api/token \\
  -H "Authorization: Bearer &lt;the JWT above&gt;"</pre>
  <p>Returns a GitHub installation token scoped to <code>${
    escapeHtml(repo)
  }</code>, valid ~1 hour. Re-request as needed.</p>
  ${backLink()}`;
}

function draftPage(draft: import("../store.ts").Draft, baseUrl: string): string {
  const target = draft.target.kind === "issue"
    ? `issue #${draft.target.issueNumber}`
    : `discussion #${draft.target.discussionNumber}${
      draft.target.replyToId ? ` (reply to ${escapeHtml(draft.target.replyToId)})` : ""
    }`;

  if (draft.status === "posted") {
    return `<div class="card"><p class="ok"><strong>Posted.</strong>
      <a href="${escapeHtml(draft.postedUrl ?? "#")}">View comment on GitHub →</a></p></div>
      <h3>Comment</h3><pre>${escapeHtml(draft.body)}</pre>${backLink()}`;
  }
  if (draft.status === "dismissed") {
    return `<div class="card"><p class="muted">This draft was dismissed.</p></div>
      <h3>Comment</h3><pre>${escapeHtml(draft.body)}</pre>${backLink()}`;
  }

  return `
  <div class="card">
    <p>An agent drafted this comment for <strong>${escapeHtml(draft.repo)}</strong> · ${target}.</p>
    <p class="muted">Review it below. Posting uses <em>your</em> GitHub identity.</p>
  </div>
  <h3>Comment</h3>
  <pre>${escapeHtml(draft.body)}</pre>
  <div class="row">
    <form method="post" action="/drafts/${escapeHtml(draft.id)}/post">
      <button type="submit">Post as me</button>
    </form>
    <form method="post" action="/drafts/${escapeHtml(draft.id)}/dismiss">
      <button type="submit" class="secondary">Dismiss</button>
    </form>
  </div>
  ${backLink()}
  <p class="muted" style="margin-top:2rem">Draft URL: <code>${escapeHtml(baseUrl)}/drafts/${
    escapeHtml(draft.id)
  }</code></p>`;
}
