/**
 * Parsing and modeling of fine-grained repository access scopes.
 *
 * A scope grants a coding agent a specific {@link Permission} on a single
 * repository, written as `owner/repo:permission`, e.g. `dtinth/claw:read`.
 */

/** The access levels an agent can be granted on a repository. */
export const PERMISSIONS = ["read", "write", "admin"] as const;

/** A single access level, one of {@link PERMISSIONS}. */
export type Permission = (typeof PERMISSIONS)[number];

/** A parsed access scope: a permission granted on one repository. */
export interface Scope {
  /** The repository owner (user or organization). */
  owner: string;
  /** The repository name. */
  repo: string;
  /** The permission granted on the repository. */
  permission: Permission;
}

/** Thrown when a scope string cannot be parsed. */
export class ScopeParseError extends Error {
  override name = "ScopeParseError";
  constructor(
    readonly input: string,
    reason: string,
  ) {
    super(`invalid scope "${input}": ${reason}`);
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Parse a scope string of the form `owner/repo:permission`.
 *
 * @throws {ScopeParseError} if the string is not a well-formed scope.
 */
export function parseScope(input: string): Scope {
  const [repoPart, permPart, ...rest] = input.split(":");
  if (repoPart === undefined || permPart === undefined || rest.length > 0) {
    throw new ScopeParseError(input, "expected format owner/repo:permission");
  }
  if (!isPermission(permPart)) {
    throw new ScopeParseError(
      input,
      `unknown permission "${permPart}", expected one of ${PERMISSIONS.join(", ")}`,
    );
  }

  const [owner, repo, ...extra] = repoPart.split("/");
  if (owner === undefined || repo === undefined || extra.length > 0) {
    throw new ScopeParseError(input, "expected exactly one owner/repo pair");
  }
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
    throw new ScopeParseError(input, "owner and repo may only contain [A-Za-z0-9._-]");
  }

  return { owner, repo, permission: permPart };
}

/** Render a {@link Scope} back to its canonical `owner/repo:permission` string. */
export function formatScope(scope: Scope): string {
  return `${scope.owner}/${scope.repo}:${scope.permission}`;
}
