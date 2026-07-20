/**
 * Command dispatch. Every external effect — the clock, network, subprocess
 * spawning, stdio — goes through {@link Runtime} so the whole CLI is testable
 * without touching the real filesystem's git config or spawning real
 * processes. Filesystem reads/writes (grants, cache) are the exception: they
 * go through the real Deno fs directly, exercised in tests via temp dirs.
 */
import { clearCache } from "./cache.ts";
import { loadConfigOrEmpty, setBaseUrl } from "./config_store.ts";
import { findGrant, loadGrants, upsertGrant } from "./grants.ts";
import { decodeClawJwtPayload } from "./jwt_decode.ts";
import { runMonitorLoop } from "./monitor.ts";
import { type Paths, resolvePaths } from "./paths.ts";
import { resolveRepo } from "./resolve_repo.ts";
import { getToken } from "./token.ts";

const MONITOR_USAGE =
  "usage: claw monitor <issue> [--repo owner/repo] [--authors a,b] [--interval 10]";

const HELP_TEXT = `claw — mint repo-scoped GitHub tokens from a claw JWT

Usage:
  claw grant [<jwt>]                    Save a claw JWT (paste it, or pipe it via stdin)
  claw set server <url>                 Save the claw server URL (or print it, with no <url>)
  claw token [--repo owner/repo]        Print a token for the repo (mint or reuse the cache)
  claw exec [--repo owner/repo] -- CMD  Run CMD with GH_TOKEN and CLAW_REPO set
  claw monitor <issue> [--repo owner/repo] [--authors a,b] [--interval 10]
                                         Poll for new comments on one issue/PR, one JSON per line
  claw setup                            Point git's github.com credential helper at gh
  claw doctor                           Check config, grants, and git wiring

Repo resolution: --repo, then $CLAW_REPO, then the git origin remote.
Server resolution: $CLAW_BASE_URL, then the config file (\`claw set server <url>\`).

Config:
  CLAW_CONFIG_DIR    grants.json/config.json directory (default: \${XDG_CONFIG_HOME:-~/.config}/claw)
  CLAW_CACHE_DIR     token cache directory (default: \${XDG_CACHE_HOME:-~/.cache}/claw)

Grants file ($CLAW_CONFIG_DIR/grants.json): {"owner/repo": "<claw JWT>"}
`;

const GITHUB_HELPER_KEY = "credential.https://github.com.helper";
const GH_HELPER_VALUE = "!gh auth git-credential";

/** Everything external the CLI touches, injectable for tests. */
export interface Runtime {
  env: Record<string, string | undefined>;
  now: () => Date;
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Run a command and capture its output (used for git/gh introspection). */
  runCommand: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Spawn a command with inherited stdio (used for `claw exec`'s child). */
  spawnInteractive: (
    cmd: string,
    args: string[],
    envOverrides: Record<string, string>,
  ) => Promise<{ code: number }>;
  /** Read a single line from stdin (used by `claw grant` when no token is given as an arg). */
  readLine: () => Promise<string>;
  /** Delay for the given milliseconds (used by `claw monitor`'s poll loop). */
  sleep: (ms: number) => Promise<void>;
}

async function getGitRemoteUrl(rt: Runtime): Promise<string | null> {
  const result = await rt.runCommand("git", ["remote", "get-url", "origin"]);
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

function extractRepoFlag(args: string[]): { repo?: string; rest: string[] } {
  const rest: string[] = [];
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo") {
      repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else {
      rest.push(arg);
    }
  }
  return repo !== undefined ? { repo, rest } : { rest };
}

function configPath(paths: Paths): string {
  return `${paths.configDir}/config.json`;
}

/** `$CLAW_BASE_URL`, falling back to whatever `claw set server` saved. */
async function resolveBaseUrlValue(rt: Runtime, paths: Paths): Promise<string | undefined> {
  const fromEnv = rt.env.CLAW_BASE_URL?.trim();
  if (fromEnv) return fromEnv;
  const config = await loadConfigOrEmpty(configPath(paths));
  return config.baseUrl;
}

interface Context {
  paths: Paths;
  grants: Record<string, string>;
  repo: string;
  baseUrl: string;
}

async function resolveContext(repoFlag: string | undefined, rt: Runtime): Promise<Context> {
  const paths = resolvePaths(rt.env);
  const baseUrl = await resolveBaseUrlValue(rt, paths);
  if (!baseUrl) {
    throw new Error(
      "no claw server configured — export CLAW_BASE_URL, or run `claw set server <url>`",
    );
  }
  const repo = await resolveRepo({
    ...(repoFlag !== undefined ? { explicit: repoFlag } : {}),
    env: rt.env,
    getGitRemoteUrl: () => getGitRemoteUrl(rt),
  });
  const grants = await loadGrants(`${paths.configDir}/grants.json`);
  return { paths, grants, repo, baseUrl };
}

function formatPermissions(permissions: Record<string, string>): string {
  const entries = Object.entries(permissions).map(([name, level]) => `${name}:${level}`);
  return entries.length > 0 ? entries.join(", ") : "(none)";
}

async function cmdGrant(args: string[], rt: Runtime): Promise<number> {
  let token = args[0]?.trim();
  if (!token) {
    rt.stderr("Paste the claw JWT (from the claw web UI), then press Enter:\n");
    token = (await rt.readLine()).trim();
  }
  if (!token) {
    rt.stderr("claw: no token given — pass it as an argument or pipe it via stdin\n");
    return 1;
  }

  const decoded = decodeClawJwtPayload(token);
  const paths = resolvePaths(rt.env);
  const path = `${paths.configDir}/grants.json`;
  const { replaced } = await upsertGrant(path, decoded.repo, token);
  // A still-unexpired cached token would otherwise keep being served under
  // the old grant for up to an hour after this one replaces it.
  await clearCache(paths.cacheDir, decoded.repo);

  const expiryText = decoded.expiresAt ? decoded.expiresAt.toISOString() : "unknown";
  rt.stdout(
    `claw: ${replaced ? "updated" : "added"} the grant for ${decoded.repo}\n` +
      `  permissions: ${formatPermissions(decoded.permissions)}\n` +
      `  expires:     ${expiryText}\n` +
      (decoded.label ? `  label:       ${decoded.label}\n` : "") +
      `  saved to:    ${path}\n`,
  );
  return 0;
}

async function cmdSet(args: string[], rt: Runtime): Promise<number> {
  const [key, ...rest] = args;
  if (key !== "server") {
    rt.stderr("usage: claw set server <url>\n");
    return 1;
  }
  const paths = resolvePaths(rt.env);
  const path = configPath(paths);
  const raw = rest[0]?.trim();

  if (!raw) {
    const current = await loadConfigOrEmpty(path);
    if (current.baseUrl) {
      rt.stdout(current.baseUrl + "\n");
      return 0;
    }
    rt.stderr("claw: no server configured yet — usage: claw set server <url>\n");
    return 1;
  }

  let normalized: string;
  try {
    normalized = new URL(raw).toString().replace(/\/$/, "");
  } catch {
    rt.stderr(`claw: "${raw}" is not a valid URL\n`);
    return 1;
  }

  await setBaseUrl(path, normalized);
  rt.stdout(`claw: server set to ${normalized}\n  saved to: ${path}\n`);
  return 0;
}

interface MonitorArgs {
  issue?: number;
  repo?: string;
  authors?: string[];
  intervalSeconds?: number;
  error?: string;
}

function parseMonitorArgs(args: string[]): MonitorArgs {
  let repo: string | undefined;
  let authors: string[] | undefined;
  let intervalSeconds: number | undefined;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--repo") {
      repo = args[++i];
    } else if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
    } else if (arg === "--authors") {
      authors = (args[++i] ?? "").split(",").map((a) => a.trim()).filter(Boolean);
    } else if (arg.startsWith("--authors=")) {
      authors = arg.slice("--authors=".length).split(",").map((a) => a.trim()).filter(Boolean);
    } else if (arg === "--interval") {
      intervalSeconds = Number(args[++i]);
    } else if (arg.startsWith("--interval=")) {
      intervalSeconds = Number(arg.slice("--interval=".length));
    } else {
      positional.push(arg);
    }
  }

  const issueRaw = positional[0];
  const issue = issueRaw !== undefined ? Number(issueRaw) : NaN;
  if (issueRaw === undefined || !Number.isInteger(issue) || issue <= 0) {
    return { error: MONITOR_USAGE };
  }
  if (
    intervalSeconds !== undefined && (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0)
  ) {
    return { error: `claw: --interval must be a positive number of seconds` };
  }

  return {
    issue,
    ...(repo !== undefined ? { repo } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
  };
}

async function cmdMonitor(args: string[], rt: Runtime): Promise<number> {
  const parsed = parseMonitorArgs(args);
  if (parsed.error || parsed.issue === undefined) {
    rt.stderr((parsed.error ?? MONITOR_USAGE) + "\n");
    return 1;
  }

  const context = await resolveContext(parsed.repo, rt);
  const jwt = findGrant(context.grants, context.repo);
  const intervalMs = (parsed.intervalSeconds ?? 10) * 1000;

  rt.stderr(
    `claw monitor: watching ${context.repo}#${parsed.issue} every ${
      intervalMs / 1000
    }s (Ctrl-C to stop)...\n`,
  );

  try {
    await runMonitorLoop({
      baseUrl: context.baseUrl,
      jwt,
      issue: parsed.issue,
      ...(parsed.authors ? { authors: parsed.authors } : {}),
      intervalMs,
      fetch: rt.fetch,
      stdout: rt.stdout,
      stderr: rt.stderr,
      sleep: rt.sleep,
    });
    return 0;
  } catch {
    return 1;
  }
}

async function cmdToken(args: string[], rt: Runtime): Promise<number> {
  const { repo: repoFlag } = extractRepoFlag(args);
  const context = await resolveContext(repoFlag, rt);
  const { token } = await getToken({
    repo: context.repo,
    grants: context.grants,
    cacheDir: context.paths.cacheDir,
    baseUrl: context.baseUrl,
    fetch: rt.fetch,
    now: rt.now(),
  });
  rt.stdout(token + "\n");
  return 0;
}

async function cmdExec(args: string[], rt: Runtime): Promise<number> {
  const { repo: repoFlag, rest } = extractRepoFlag(args);
  const sepIndex = rest.indexOf("--");
  if (sepIndex === -1 || sepIndex === rest.length - 1) {
    rt.stderr("usage: claw exec [--repo owner/repo] -- <command> [args...]\n");
    return 1;
  }
  const command = rest.slice(sepIndex + 1);
  const context = await resolveContext(repoFlag, rt);
  const { token } = await getToken({
    repo: context.repo,
    grants: context.grants,
    cacheDir: context.paths.cacheDir,
    baseUrl: context.baseUrl,
    fetch: rt.fetch,
    now: rt.now(),
  });
  const [bin, ...binArgs] = command;
  const result = await rt.spawnInteractive(bin!, binArgs, {
    GH_TOKEN: token,
    CLAW_REPO: context.repo,
  });
  return result.code;
}

async function cmdSetup(_args: string[], rt: Runtime): Promise<number> {
  // Clear first: --add alone would pile up a duplicate entry on every re-run.
  const clear = await rt.runCommand("git", [
    "config",
    "--global",
    "--replace-all",
    GITHUB_HELPER_KEY,
    "",
  ]);
  if (clear.code !== 0) {
    rt.stderr(`claw: failed to reset the existing git credential helper: ${clear.stderr}\n`);
    return clear.code;
  }
  const add = await rt.runCommand("git", [
    "config",
    "--global",
    "--add",
    GITHUB_HELPER_KEY,
    GH_HELPER_VALUE,
  ]);
  if (add.code !== 0) {
    rt.stderr(`claw: failed to install the gh git credential helper: ${add.stderr}\n`);
    return add.code;
  }
  rt.stdout(
    `claw: git's github.com credential helper is now \`${GH_HELPER_VALUE}\`, which reads\n` +
      "GH_TOKEN — run git through `claw exec -- git ...` so it's set.\n",
  );
  return 0;
}

async function cmdDoctor(_args: string[], rt: Runtime): Promise<number> {
  let ok = true;
  const lines: string[] = [];

  let paths: Paths | undefined;
  try {
    paths = resolvePaths(rt.env);
    lines.push(`ok    config dir: ${paths.configDir}`);
    lines.push(`ok    cache dir:  ${paths.cacheDir}`);
  } catch (error) {
    ok = false;
    lines.push(`FAIL  paths: ${error instanceof Error ? error.message : String(error)}`);
  }

  const baseUrl = paths ? await resolveBaseUrlValue(rt, paths) : undefined;
  if (baseUrl) {
    lines.push(`ok    server: ${baseUrl}`);
  } else {
    ok = false;
    lines.push(
      "FAIL  no claw server configured — export CLAW_BASE_URL or run `claw set server <url>`",
    );
  }

  if (paths) {
    try {
      const grants = await loadGrants(`${paths.configDir}/grants.json`);
      lines.push(`ok    grants file: ${Object.keys(grants).length} repo(s) configured`);
    } catch (error) {
      ok = false;
      lines.push(`FAIL  grants: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const helper = await rt.runCommand("git", ["config", "--global", "--get-all", GITHUB_HELPER_KEY]);
  const helpers = helper.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (helpers.includes(GH_HELPER_VALUE)) {
    lines.push(`ok    git credential helper: ${GH_HELPER_VALUE}`);
  } else if (helpers.length > 0) {
    ok = false;
    lines.push(
      `FAIL  git credential helper is ${
        JSON.stringify(helpers)
      }, expected "${GH_HELPER_VALUE}" — run \`claw setup\``,
    );
  } else {
    ok = false;
    lines.push("FAIL  git credential helper not configured — run `claw setup`");
  }

  const gh = await rt.runCommand("gh", ["--version"]);
  if (gh.code === 0) {
    lines.push("ok    gh is on PATH");
  } else {
    ok = false;
    lines.push("FAIL  gh not found on PATH (required by the git credential helper)");
  }

  rt.stdout(lines.join("\n") + "\n");
  return ok ? 0 : 1;
}

/** Parse argv and run the matching command, returning the process exit code. */
export async function runCli(argv: string[], rt: Runtime): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "grant":
        return await cmdGrant(rest, rt);
      case "set":
        return await cmdSet(rest, rt);
      case "monitor":
        return await cmdMonitor(rest, rt);
      case "token":
        return await cmdToken(rest, rt);
      case "exec":
        return await cmdExec(rest, rt);
      case "setup":
        return await cmdSetup(rest, rt);
      case "doctor":
        return await cmdDoctor(rest, rt);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        rt.stdout(HELP_TEXT);
        return 0;
      default:
        rt.stderr(`claw: unknown command "${command}"\n\n${HELP_TEXT}`);
        return 1;
    }
  } catch (error) {
    rt.stderr(`claw: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
