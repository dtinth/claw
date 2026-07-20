/** A GitHub repository identified by owner and name. */
export interface Repo {
  /** The repository owner (user or organization login). */
  owner: string;
  /** The repository name. */
  repo: string;
}

/** Thrown when a `owner/repo` string cannot be parsed. */
export class RepoParseError extends Error {
  override name = "RepoParseError";
  constructor(readonly input: string, reason: string) {
    super(`invalid repository "${input}": ${reason}`);
  }
}

/** GitHub owner/repo segments allow alphanumerics plus `-`, `_` and `.`. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parse a `owner/repo` string into a {@link Repo}.
 *
 * @throws {RepoParseError} when the string is not a well-formed repository.
 */
export function parseRepo(input: string): Repo {
  const trimmed = input.trim();
  const [owner, repo, ...rest] = trimmed.split("/");
  if (owner === undefined || repo === undefined || rest.length > 0) {
    throw new RepoParseError(input, "expected format owner/repo");
  }
  if (owner === "" || repo === "") {
    throw new RepoParseError(input, "owner and repo must not be empty");
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new RepoParseError(
      input,
      "owner and repo may only contain the characters [A-Za-z0-9._-]",
    );
  }
  return { owner, repo };
}

/** Render a {@link Repo} back to its canonical `owner/repo` string. */
export function formatRepo(repo: Repo): string {
  return `${repo.owner}/${repo.repo}`;
}
