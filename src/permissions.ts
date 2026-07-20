/**
 * The subset of GitHub App repository permissions claw lets you grant, and
 * helpers to validate a permission selection before it is baked into a JWT.
 *
 * GitHub returns an installation token with *all* of the app's permissions
 * when the token request omits `permissions`. To keep tokens least-privilege
 * we always send an explicit, validated permission set — see
 * {@link parsePermissions} and {@link isEmptyPermissions}.
 */

/** Access levels a permission may be granted at. */
export type PermissionLevel = "read" | "write" | "admin";

/**
 * Repository permissions claw can request, mapped to the access levels GitHub
 * allows for each. Keys are the exact names GitHub's installation-token API
 * expects. `metadata` is read-only and is granted implicitly by GitHub, but is
 * listed so the UI can surface it.
 */
export const PERMISSION_CATALOG = {
  actions: ["read", "write"],
  checks: ["read", "write"],
  contents: ["read", "write"],
  deployments: ["read", "write"],
  discussions: ["read", "write"],
  environments: ["read", "write"],
  issues: ["read", "write"],
  metadata: ["read"],
  packages: ["read", "write"],
  pages: ["read", "write"],
  pull_requests: ["read", "write"],
  repository_hooks: ["read", "write"],
  security_events: ["read", "write"],
  statuses: ["read", "write"],
  workflows: ["write"],
} as const satisfies Record<string, readonly PermissionLevel[]>;

/** The name of a permission claw understands. */
export type PermissionName = keyof typeof PERMISSION_CATALOG;

/** A validated set of permissions, mapping permission name to access level. */
export type Permissions = Partial<Record<PermissionName, PermissionLevel>>;

/** Thrown when a permission selection is invalid. */
export class PermissionError extends Error {
  override name = "PermissionError";
}

function isKnownPermission(name: string): name is PermissionName {
  return Object.hasOwn(PERMISSION_CATALOG, name);
}

/**
 * Validate a raw permission map (e.g. from a form or JSON body). Values of
 * `"none"` or `""` mean "do not grant" and are dropped from the result.
 *
 * @throws {PermissionError} on an unknown permission name or a level the
 * permission does not allow.
 */
export function parsePermissions(input: Record<string, string>): Permissions {
  const result: Permissions = {};
  for (const [name, rawLevel] of Object.entries(input)) {
    const level = rawLevel.trim();
    if (level === "" || level === "none") continue;
    if (!isKnownPermission(name)) {
      throw new PermissionError(`unknown permission "${name}"`);
    }
    const allowed = PERMISSION_CATALOG[name] as readonly string[];
    if (!allowed.includes(level)) {
      throw new PermissionError(
        `permission "${name}" does not allow level "${level}" (allowed: ${allowed.join(", ")})`,
      );
    }
    result[name] = level as PermissionLevel;
  }
  return result;
}

/** True when no permission is granted (which would mean full app access). */
export function isEmptyPermissions(perms: Permissions): boolean {
  return Object.keys(perms).length === 0;
}

/** Render a permission set as a compact `name:level, …` string for display/logs. */
export function formatPermissions(perms: Permissions): string {
  return Object.entries(perms).map(([name, level]) => `${name}:${level}`).join(", ");
}
