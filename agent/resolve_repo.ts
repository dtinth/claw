/**
 * Deciding which repository a command applies to: an explicit `--repo` flag,
 * then `$CLAW_REPO`, then the git origin remote of the current directory.
 */
import { formatRepo, parseGitRemoteUrl, parseRepo } from "./repo.ts";

export interface ResolveRepoParams {
  /** The `--repo` flag value, if the user passed one. */
  explicit?: string;
  env: { CLAW_REPO?: string };
  /** Resolve `git remote get-url origin` for the current directory; `null` if unavailable. */
  getGitRemoteUrl: () => Promise<string | null>;
}

/** Thrown when no repository can be determined from any source. */
export class RepoResolutionError extends Error {
  override name = "RepoResolutionError";
}

/**
 * Resolve the target repository as `owner/repo`.
 *
 * @throws {RepoResolutionError} when no source yields a github.com repository.
 * @throws {RepoError} when `--repo`/`CLAW_REPO` is set but malformed.
 */
export async function resolveRepo(params: ResolveRepoParams): Promise<string> {
  const candidate = params.explicit?.trim() || params.env.CLAW_REPO?.trim();
  if (candidate) {
    return formatRepo(parseRepo(candidate));
  }

  const remote = await params.getGitRemoteUrl();
  if (remote) {
    const parsed = parseGitRemoteUrl(remote);
    if (parsed) return formatRepo(parsed);
  }

  throw new RepoResolutionError(
    "could not determine the repository: pass --repo owner/repo, set CLAW_REPO, " +
      "or run inside a git repo with a github.com origin remote",
  );
}
