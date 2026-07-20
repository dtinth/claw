/**
 * `owner/repo` parsing and github.com git-remote-URL parsing. Deliberately not
 * shared with the server's `src/github/repo.ts` — the CLI is a separate
 * project with no dependency on the server at all.
 */

/** A GitHub repository identified by owner and name. */
export interface Repo {
  owner: string;
  repo: string;
}

/** Thrown when a `owner/repo` string cannot be parsed. */
export class RepoError extends Error {
  override name = "RepoError";
  constructor(readonly input: string, reason: string) {
    super(`invalid repository "${input}": ${reason}`);
  }
}

/** GitHub owner/repo segments allow alphanumerics plus `-`, `_` and `.`. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a `owner/repo` string into a {@link Repo}.
 *
 * @throws {RepoError} when the string is not a well-formed repository.
 */
export function parseRepo(input: string): Repo {
  const trimmed = input.trim();
  const [owner, repo, ...rest] = trimmed.split("/");
  if (owner === undefined || repo === undefined || rest.length > 0) {
    throw new RepoError(input, "expected format owner/repo");
  }
  if (owner === "" || repo === "") {
    throw new RepoError(input, "owner and repo must not be empty");
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new RepoError(input, "owner and repo may only contain the characters [A-Za-z0-9._-]");
  }
  return { owner, repo };
}

/** Render a {@link Repo} back to its canonical `owner/repo` string. */
export function formatRepo(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
}

const REMOTE_URL_PATTERNS = [
  // https://[user@]github.com/owner/repo(.git)?
  /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  // ssh://git@github.com/owner/repo(.git)?
  /^ssh:\/\/[^@/]+@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  // git@github.com:owner/repo(.git)?  (scp-like syntax)
  /^[^@/]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
];

/**
 * Parse a `git remote get-url origin`-style URL into a {@link Repo}, when it
 * points at github.com. Returns `null` (never throws) for anything else, so
 * callers can fall through to another resolution strategy.
 */
export function parseGitRemoteUrl(url: string): Repo | null {
  const trimmed = url.trim();
  for (const pattern of REMOTE_URL_PATTERNS) {
    const match = pattern.exec(trimmed);
    if (match) {
      const [, owner, repo] = match;
      try {
        return parseRepo(`${owner}/${repo}`);
      } catch {
        return null;
      }
    }
  }
  return null;
}
