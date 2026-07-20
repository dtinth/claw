/**
 * A thin GitHub API client covering exactly what claw needs:
 *
 *  - minting repository-scoped installation tokens (as the app),
 *  - the user-to-server OAuth handshake,
 *  - posting issue/PR and discussion comments (as the logged-in user).
 *
 * `fetch` is injectable so the whole surface can be tested in-process against
 * canned responses without touching the network.
 */
import { createAppJwt } from "./app_jwt.ts";
import { parseRepo } from "./repo.ts";
import type { Permissions } from "../permissions.ts";

const DEFAULT_API_BASE = "https://api.github.com";
const DEFAULT_OAUTH_BASE = "https://github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "claw";

/** A repository-scoped installation access token. */
export interface InstallationToken {
  token: string;
  /** ISO-8601 expiry (GitHub installation tokens last ~1 hour). */
  expiresAt: string;
  /** The repository the token is scoped to, as `owner/repo`. */
  repository: string;
  /** The permissions actually granted on the token. */
  permissions: Permissions;
}

/** A user-to-server OAuth token. */
export interface UserToken {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
}

/** Dependencies for {@link createGitHubClient}. */
export interface GitHubClientDeps {
  appId: string;
  privateKeyPem: string;
  clientId: string;
  clientSecret: string;
  /** Injectable fetch (defaults to the global). */
  fetch?: typeof fetch;
  /** REST/GraphQL base, defaults to https://api.github.com. */
  apiBaseUrl?: string;
  /** OAuth base, defaults to https://github.com. */
  oauthBaseUrl?: string;
}

/** claw's GitHub client surface. */
export interface GitHubClient {
  mintRepoToken(repo: string, permissions: Permissions): Promise<InstallationToken>;
  buildAuthorizeUrl(params: { state: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; redirectUri: string }): Promise<UserToken>;
  getAuthenticatedUser(accessToken: string): Promise<{ login: string; id: number }>;
  postIssueComment(
    accessToken: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ htmlUrl: string }>;
  postDiscussionComment(
    accessToken: string,
    repo: string,
    discussionNumber: number,
    body: string,
    replyToId?: string,
  ): Promise<{ url: string }>;
}

/** Thrown when a GitHub API call fails. */
export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createGitHubClient(deps: GitHubClientDeps): GitHubClient {
  const fetchFn = deps.fetch ?? fetch;
  const api = (deps.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const oauth = (deps.oauthBaseUrl ?? DEFAULT_OAUTH_BASE).replace(/\/$/, "");

  function ghHeaders(authToken: string): HeadersInit {
    return {
      "Authorization": `Bearer ${authToken}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    };
  }

  const appHeaders = () => ghHeaders(createAppJwt(deps.appId, deps.privateKeyPem));
  const userHeaders = (accessToken: string) => ghHeaders(accessToken);

  async function readError(response: Response): Promise<string> {
    let detail = "";
    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as { message?: string };
      detail = parsed.message ?? text;
    } catch {
      detail = "";
    }
    return detail;
  }

  async function graphql(accessToken: string, query: string, variables: unknown): Promise<unknown> {
    const response = await fetchFn(`${api}/graphql`, {
      method: "POST",
      headers: { ...userHeaders(accessToken), "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GraphQL request failed: ${await readError(response)}`,
      );
    }
    const payload = await response.json() as { data?: unknown; errors?: { message: string }[] };
    if (payload.errors && payload.errors.length > 0) {
      throw new GitHubApiError(
        200,
        `GraphQL error: ${payload.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return payload.data;
  }

  return {
    async mintRepoToken(repo, permissions) {
      const { owner, repo: name } = parseRepo(repo);
      const headers = appHeaders();

      const installationRes = await fetchFn(`${api}/repos/${owner}/${name}/installation`, {
        headers,
      });
      if (!installationRes.ok) {
        throw new GitHubApiError(
          installationRes.status,
          `could not find an installation for ${repo} (HTTP ${installationRes.status}: ${await readError(
            installationRes,
          )})`,
        );
      }
      const installation = await installationRes.json() as { id: number };

      const tokenRes = await fetchFn(
        `${api}/app/installations/${installation.id}/access_tokens`,
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ repositories: [name], permissions }),
        },
      );
      if (!tokenRes.ok) {
        throw new GitHubApiError(
          tokenRes.status,
          `could not mint an installation token for ${repo} (HTTP ${tokenRes.status}: ${await readError(
            tokenRes,
          )})`,
        );
      }
      const token = await tokenRes.json() as {
        token: string;
        expires_at: string;
        permissions?: Permissions;
      };
      return {
        token: token.token,
        expiresAt: token.expires_at,
        repository: repo,
        permissions: token.permissions ?? permissions,
      };
    },

    buildAuthorizeUrl({ state, redirectUri }) {
      const url = new URL(`${oauth}/login/oauth/authorize`);
      url.searchParams.set("client_id", deps.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode({ code, redirectUri }) {
      const response = await fetchFn(`${oauth}/login/oauth/access_token`, {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "content-type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `token exchange failed: ${await readError(response)}`,
        );
      }
      const data = await response.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };
      if (data.error || !data.access_token) {
        throw new GitHubApiError(
          400,
          `token exchange failed: ${data.error ?? "no access_token"} ${
            data.error_description ?? ""
          }`.trim(),
        );
      }
      const userToken: UserToken = { accessToken: data.access_token };
      if (data.refresh_token) userToken.refreshToken = data.refresh_token;
      if (data.expires_in !== undefined) userToken.expiresInSeconds = data.expires_in;
      return userToken;
    },

    async getAuthenticatedUser(accessToken) {
      const response = await fetchFn(`${api}/user`, { headers: userHeaders(accessToken) });
      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `could not read the authenticated user: ${await readError(response)}`,
        );
      }
      const user = await response.json() as { login: string; id: number };
      return { login: user.login, id: user.id };
    },

    async postIssueComment(accessToken, repo, issueNumber, body) {
      const { owner, repo: name } = parseRepo(repo);
      const response = await fetchFn(
        `${api}/repos/${owner}/${name}/issues/${issueNumber}/comments`,
        {
          method: "POST",
          headers: { ...userHeaders(accessToken), "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (!response.ok) {
        throw new GitHubApiError(
          response.status,
          `could not post comment: ${await readError(response)}`,
        );
      }
      const comment = await response.json() as { html_url: string };
      return { htmlUrl: comment.html_url };
    },

    async postDiscussionComment(accessToken, repo, discussionNumber, body, replyToId) {
      const { owner, repo: name } = parseRepo(repo);
      const resolved = await graphql(
        accessToken,
        `query($owner:String!,$name:String!,$number:Int!){
          repository(owner:$owner,name:$name){ discussion(number:$number){ id } }
        }`,
        { owner, name, number: discussionNumber },
      ) as { repository?: { discussion?: { id?: string } } };
      const discussionId = resolved.repository?.discussion?.id;
      if (!discussionId) {
        throw new GitHubApiError(404, `discussion #${discussionNumber} not found in ${repo}`);
      }

      const mutated = await graphql(
        accessToken,
        `mutation($discussionId:ID!,$body:String!,$replyToId:ID){
          addDiscussionComment(input:{discussionId:$discussionId,body:$body,replyToId:$replyToId}){
            comment{ url }
          }
        }`,
        { discussionId, body, replyToId: replyToId ?? null },
      ) as { addDiscussionComment?: { comment?: { url?: string } } };
      const url = mutated.addDiscussionComment?.comment?.url;
      if (!url) {
        throw new GitHubApiError(500, "discussion comment did not return a url");
      }
      return { url };
    },
  };
}
