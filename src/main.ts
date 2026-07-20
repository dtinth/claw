/**
 * claw — command-line entry point.
 *
 * For now this validates the access scopes passed on the command line and
 * prints them in canonical form. It exists mainly to give the project a
 * runnable entry point to grow from.
 */
import { formatScope, parseScope, ScopeParseError } from "./scope.ts";

const USAGE = `claw — fine-grained repository access for coding agents

Usage:
  deno run src/main.ts <scope>...

Each <scope> is written as owner/repo:permission, e.g. dtinth/claw:read
Permissions: read, write, admin`;

export function main(args: string[]): number {
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return args.length === 0 ? 1 : 0;
  }

  let ok = true;
  for (const arg of args) {
    try {
      console.log(formatScope(parseScope(arg)));
    } catch (error) {
      ok = false;
      console.error(error instanceof ScopeParseError ? error.message : error);
    }
  }
  return ok ? 0 : 1;
}

if (import.meta.main) {
  Deno.exit(main(Deno.args));
}
