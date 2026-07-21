import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { readCache, writeCache } from "./cache.ts";
import { resolveUploadFilename, runCli } from "./cli.ts";
import type { Runtime } from "./cli.ts";

interface CommandCall {
  cmd: string;
  args: string[];
}

interface FakeRuntimeOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  fetchHandler?: () => Response;
  /** Keyed by `"cmd arg1 arg2"`; defaults to a non-zero exit for unlisted commands. */
  commandOutputs?: Record<string, { code: number; stdout?: string; stderr?: string }>;
  spawnCode?: number;
  stdin?: string;
}

function makeFakeRuntime(opts: FakeRuntimeOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commandCalls: CommandCall[] = [];
  const spawnCalls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
  const fetchCalls: string[] = [];

  const rt: Runtime = {
    env: opts.env ?? {},
    now: () => opts.now ?? new Date("2026-07-21T00:00:00Z"),
    fetch: ((input: string | URL | Request): Promise<Response> => {
      fetchCalls.push(typeof input === "string" ? input : input.toString());
      const handler = opts.fetchHandler ??
        (() => {
          throw new Error("unexpected fetch call");
        });
      return Promise.resolve(handler());
      // deno-lint-ignore no-explicit-any
    }) as any,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    runCommand: (cmd, args) => {
      commandCalls.push({ cmd, args });
      const key = [cmd, ...args].join(" ");
      const result = opts.commandOutputs?.[key];
      return Promise.resolve(
        result
          ? { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
          : { code: 1, stdout: "", stderr: `no fake output configured for: ${key}` },
      );
    },
    spawnInteractive: (cmd, args, env) => {
      spawnCalls.push({ cmd, args, env });
      return Promise.resolve({ code: opts.spawnCode ?? 0 });
    },
    readLine: () => Promise.resolve(opts.stdin ?? ""),
    sleep: () => Promise.resolve(),
  };

  return { rt, stdout, stderr, commandCalls, spawnCalls, fetchCalls };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fakeClawJwt(payload: Record<string, unknown>): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  return `${header}.${body}.not-a-real-signature`;
}

// --- claw grant --------------------------------------------------------

Deno.test("grant: saves a grant taken as a positional argument", async () => {
  const configDir = await Deno.makeTempDir();
  const token = fakeClawJwt({
    sub: "dtinth/claw",
    perms: { contents: "write" },
    exp: 1_800_000_000,
  });
  const { rt, stdout } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });

  const code = await runCli(["grant", token], rt);

  assertEquals(code, 0);
  const saved = JSON.parse(await Deno.readTextFile(`${configDir}/grants.json`));
  assertEquals(saved, { "dtinth/claw": token });
  const output = stdout.join("");
  assertStringIncludes(output, "added the grant for dtinth/claw");
  assertStringIncludes(output, "contents:write");
});

Deno.test("grant: reads the token from stdin when no argument is given", async () => {
  const configDir = await Deno.makeTempDir();
  const token = fakeClawJwt({ sub: "dtinth/claw" });
  const { rt } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
    stdin: `${token}\n`,
  });

  const code = await runCli(["grant"], rt);

  assertEquals(code, 0);
  const saved = JSON.parse(await Deno.readTextFile(`${configDir}/grants.json`));
  assertEquals(saved, { "dtinth/claw": token });
});

Deno.test("grant: reports 'updated' when a grant already exists for that repo", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "old.token" }),
  );
  const token = fakeClawJwt({ sub: "dtinth/claw" });
  const { rt, stdout } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });

  const code = await runCli(["grant", token], rt);

  assertEquals(code, 0);
  assertStringIncludes(stdout.join(""), "updated the grant for dtinth/claw");
});

Deno.test("grant: clears any cached token for the repo (a new grant invalidates it)", async () => {
  const configDir = await Deno.makeTempDir();
  const cacheDir = await Deno.makeTempDir();
  await writeCache(cacheDir, "dtinth/claw", {
    token: "ghs_stale",
    expiresAt: "2099-01-01T00:00:00Z", // still "fresh" by expiry alone
  });
  const token = fakeClawJwt({ sub: "dtinth/claw" });
  const { rt } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir, CLAW_CACHE_DIR: cacheDir },
  });

  const code = await runCli(["grant", token], rt);

  assertEquals(code, 0);
  assertEquals(await readCache(cacheDir, "dtinth/claw"), null);
});

Deno.test("grant: fails cleanly on a malformed token", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["grant", "not-a-jwt"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "JWT");
});

Deno.test("grant: fails cleanly when neither an argument nor stdin has a token", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" }, stdin: "" });
  const code = await runCli(["grant"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "no token given");
});

// --- claw set server ---------------------------------------------------

Deno.test("set server: saves a normalized URL to the config file", async () => {
  const configDir = await Deno.makeTempDir();
  const { rt, stdout } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });

  const code = await runCli(["set", "server", "https://claw.example.com/"], rt);

  assertEquals(code, 0);
  assertStringIncludes(stdout.join(""), "https://claw.example.com");
  const saved = JSON.parse(await Deno.readTextFile(`${configDir}/config.json`));
  assertEquals(saved.baseUrl, "https://claw.example.com");
});

Deno.test("set server: prints the currently configured URL when called with none", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/config.json`,
    JSON.stringify({ baseUrl: "https://claw.example.com" }),
  );
  const { rt, stdout } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });

  const code = await runCli(["set", "server"], rt);

  assertEquals(code, 0);
  assertEquals(stdout, ["https://claw.example.com\n"]);
});

Deno.test("set server: fails cleanly when nothing is configured and none is given", async () => {
  const configDir = await Deno.makeTempDir();
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });
  const code = await runCli(["set", "server"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "usage");
});

Deno.test("set server: rejects an invalid URL", async () => {
  const configDir = await Deno.makeTempDir();
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_CONFIG_DIR: configDir },
  });
  const code = await runCli(["set", "server", "not a url"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "not a valid URL");
});

// --- claw token ------------------------------------------------------------

Deno.test("token: falls back to the config file when CLAW_BASE_URL is unset", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );
  await Deno.writeTextFile(
    `${configDir}/config.json`,
    JSON.stringify({ baseUrl: "https://from-config.example.com" }),
  );
  const { rt, stdout, fetchCalls } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_fromconfig",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      }),
  });

  const code = await runCli(["token"], rt);

  assertEquals(code, 0);
  assertEquals(stdout, ["ghs_fromconfig\n"]);
  assertStringIncludes(fetchCalls[0]!, "https://from-config.example.com");
});

Deno.test("token: CLAW_BASE_URL overrides the config file", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );
  await Deno.writeTextFile(
    `${configDir}/config.json`,
    JSON.stringify({ baseUrl: "https://from-config.example.com" }),
  );
  const { rt, fetchCalls } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://from-env.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_fromenv",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      }),
  });

  const code = await runCli(["token"], rt);

  assertEquals(code, 0);
  assertStringIncludes(fetchCalls[0]!, "https://from-env.example.com");
});

Deno.test("token: prints the minted token for the resolved repo", async () => {
  const { rt, stdout } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_minted",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      }),
    commandOutputs: {},
  });
  // Seed the grants file the loadGrants() call inside cli.ts will read.
  const configDir = await Deno.makeTempDir();
  rt.env.CLAW_CONFIG_DIR = configDir;
  rt.env.CLAW_CACHE_DIR = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );

  const code = await runCli(["token"], rt);

  assertEquals(code, 0);
  assertEquals(stdout, ["ghs_minted\n"]);
});

Deno.test("token: fails cleanly when CLAW_BASE_URL is not set", async () => {
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_REPO: "dtinth/claw" },
  });
  const code = await runCli(["token"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "CLAW_BASE_URL");
});

Deno.test("token: fails cleanly when no repo can be resolved", async () => {
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_BASE_URL: "https://claw.example.com" },
    commandOutputs: { "git remote get-url origin": { code: 1 } },
  });
  const code = await runCli(["token"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "repository");
});

Deno.test("token: --repo overrides CLAW_REPO", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/other": "the.jwt" }),
  );
  const { rt, stdout } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_other",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/other",
        permissions: {},
      }),
  });
  const code = await runCli(["token", "--repo", "dtinth/other"], rt);
  assertEquals(code, 0);
  assertEquals(stdout, ["ghs_other\n"]);
});

// --- claw exec ---------------------------------------------------------

Deno.test("exec: spawns the command with GH_TOKEN and CLAW_REPO set", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );
  const { rt, spawnCalls } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_execd",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      }),
    spawnCode: 0,
  });

  const code = await runCli(["exec", "--", "git", "push"], rt);

  assertEquals(code, 0);
  assertEquals(spawnCalls.length, 1);
  assertEquals(spawnCalls[0]!.cmd, "git");
  assertEquals(spawnCalls[0]!.args, ["push"]);
  assertEquals(spawnCalls[0]!.env.GH_TOKEN, "ghs_execd");
  assertEquals(spawnCalls[0]!.env.CLAW_REPO, "dtinth/claw");
});

Deno.test("exec: propagates the child's exit code", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );
  const { rt } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    fetchHandler: () =>
      jsonResponse({
        token: "ghs_x",
        expires_at: "2026-07-21T01:00:00Z",
        repository: "dtinth/claw",
        permissions: {},
      }),
    spawnCode: 17,
  });
  const code = await runCli(["exec", "--", "false"], rt);
  assertEquals(code, 17);
});

Deno.test("exec: requires a -- separator", async () => {
  const { rt, stderr, spawnCalls } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["exec", "git", "push"], rt);
  assertEquals(code, 1);
  assertEquals(spawnCalls.length, 0);
  assertStringIncludes(stderr.join(""), "usage");
});

// --- claw monitor --------------------------------------------------------
//
// Only the fast-fail validation paths are covered here (the CLI dispatch
// layer's job); the actual poll loop is monitor_test.ts's job, exercised
// directly against runMonitorLoop with a bounded shouldStop.

Deno.test("monitor: requires an issue number", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["monitor"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "usage");
});

Deno.test("monitor: rejects a non-numeric issue", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["monitor", "not-a-number"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "usage");
});

Deno.test("monitor: fails cleanly when no claw server is configured", async () => {
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_REPO: "dtinth/claw" },
  });
  const code = await runCli(["monitor", "24"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "CLAW_BASE_URL");
});

Deno.test("monitor: fails cleanly when no repo can be resolved", async () => {
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_BASE_URL: "https://claw.example.com" },
    commandOutputs: { "git remote get-url origin": { code: 1 } },
  });
  const code = await runCli(["monitor", "24"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "repository");
});

Deno.test("monitor: fails cleanly when there is no grant for the repo", async () => {
  const configDir = await Deno.makeTempDir();
  // grants.json deliberately has no entry for dtinth/claw.
  await Deno.writeTextFile(`${configDir}/grants.json`, JSON.stringify({}));
  const { rt, stderr } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
  });
  const code = await runCli(["monitor", "24"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "no grant for dtinth/claw");
});

Deno.test("monitor: rejects a non-positive --interval", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["monitor", "24", "--interval", "0"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "--interval");
});

// --- resolveUploadFilename ---------------------------------------------------

Deno.test("resolveUploadFilename: --filename wins outright", () => {
  const name = resolveUploadFilename(
    { filename: "renamed.png", keepFilename: true },
    "/tmp/original.jpg",
  );
  assertEquals(name, "renamed.png");
});

Deno.test("resolveUploadFilename: --keep-filename uses the local basename", () => {
  const name = resolveUploadFilename({ keepFilename: true }, "/tmp/original.jpg");
  assertEquals(name, "original.jpg");
});

Deno.test("resolveUploadFilename: defaults to image.ext for an image extension", () => {
  assertEquals(resolveUploadFilename({}, "/tmp/screenshot.png"), "image.png");
  assertEquals(resolveUploadFilename({}, "/tmp/photo.JPEG"), "image.JPEG");
});

Deno.test("resolveUploadFilename: defaults to file.ext for a non-image extension", () => {
  assertEquals(resolveUploadFilename({}, "/tmp/notes.txt"), "file.txt");
  assertEquals(resolveUploadFilename({}, "/tmp/build.log"), "file.log");
});

Deno.test("resolveUploadFilename: defaults to plain file when the path has no extension", () => {
  assertEquals(resolveUploadFilename({}, "/tmp/noext"), "file");
});

// --- claw upload -----------------------------------------------------------
//
// Only the CLI dispatch layer is covered here (arg parsing, filename
// resolution, wiring); the HTTP request shape is upload_client_test.ts's job.

Deno.test("upload: requires a path", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["upload"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "usage");
});

Deno.test("upload: rejects --keep-filename combined with --filename", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["upload", "x.png", "--keep-filename", "--filename", "y.png"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "mutually exclusive");
});

Deno.test("upload: fails cleanly when the local file does not exist", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: { HOME: "/home/dtinth" } });
  const code = await runCli(["upload", "/no/such/file.png"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "no such file");
});

Deno.test("upload: fails cleanly when no claw server is configured", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/x.png`;
  await Deno.writeTextFile(path, "pixels");
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_REPO: "dtinth/claw" },
  });
  const code = await runCli(["upload", path], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "CLAW_BASE_URL");
});

Deno.test("upload: fails cleanly when no repo can be resolved", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/x.png`;
  await Deno.writeTextFile(path, "pixels");
  const { rt, stderr } = makeFakeRuntime({
    env: { HOME: "/home/dtinth", CLAW_BASE_URL: "https://claw.example.com" },
    commandOutputs: { "git remote get-url origin": { code: 1 } },
  });
  const code = await runCli(["upload", path], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "repository");
});

Deno.test("upload: fails cleanly when there is no grant for the repo", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/x.png`;
  await Deno.writeTextFile(path, "pixels");
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${configDir}/grants.json`, JSON.stringify({}));
  const { rt, stderr } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
  });
  const code = await runCli(["upload", path], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "no grant for dtinth/claw");
});

async function seedUploadGrant(rt: Runtime) {
  const configDir = await Deno.makeTempDir();
  rt.env.CLAW_CONFIG_DIR = configDir;
  rt.env.CLAW_CACHE_DIR = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${configDir}/grants.json`,
    JSON.stringify({ "dtinth/claw": "the.jwt" }),
  );
}

Deno.test("upload: prints the returned URL on success", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/screenshot.png`;
  await Deno.writeTextFile(path, "pixels");
  const { rt, stdout } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
    },
    fetchHandler: () =>
      jsonResponse({ url: "https://im.example.com/ipfs/bafy/deadbeef.png", cid: "bafy" }),
  });
  await seedUploadGrant(rt);

  const code = await runCli(["upload", path], rt);

  assertEquals(code, 0);
  assertEquals(stdout, ["https://im.example.com/ipfs/bafy/deadbeef.png\n"]);
});

Deno.test("upload: reports the server error and exits 1 on failure", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/screenshot.png`;
  await Deno.writeTextFile(path, "pixels");
  const { rt, stderr } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_REPO: "dtinth/claw",
    },
    fetchHandler: () =>
      new Response(JSON.stringify({ error: "upload storage is not configured" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });
  await seedUploadGrant(rt);

  const code = await runCli(["upload", path], rt);

  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "upload storage is not configured");
});

// --- claw setup ----------------------------------------------------------

Deno.test("setup: clears then installs the gh credential helper for github.com", async () => {
  const { rt, commandCalls, stdout } = makeFakeRuntime({
    env: { HOME: "/home/dtinth" },
    commandOutputs: {
      "git config --global --replace-all credential.https://github.com.helper ": { code: 0 },
      "git config --global --add credential.https://github.com.helper !gh auth git-credential": {
        code: 0,
      },
    },
  });
  const code = await runCli(["setup"], rt);
  assertEquals(code, 0);
  assertEquals(commandCalls[0], {
    cmd: "git",
    args: [
      "config",
      "--global",
      "--replace-all",
      "credential.https://github.com.helper",
      "",
    ],
  });
  assertEquals(commandCalls[1], {
    cmd: "git",
    args: [
      "config",
      "--global",
      "--add",
      "credential.https://github.com.helper",
      "!gh auth git-credential",
    ],
  });
  assertStringIncludes(stdout.join(""), "gh auth git-credential");
});

Deno.test("setup: fails if the git config call fails", async () => {
  const { rt } = makeFakeRuntime({
    env: { HOME: "/home/dtinth" },
    commandOutputs: {
      "git config --global --replace-all credential.https://github.com.helper ": { code: 1 },
    },
  });
  const code = await runCli(["setup"], rt);
  assertEquals(code, 1);
});

// --- claw doctor -----------------------------------------------------------

Deno.test("doctor: reports ok when everything is configured", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${configDir}/grants.json`, JSON.stringify({ "dtinth/claw": "jwt" }));
  const { rt, stdout } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    commandOutputs: {
      "git config --global --get-all credential.https://github.com.helper": {
        code: 0,
        stdout: "!gh auth git-credential\n",
      },
      "gh --version": { code: 0, stdout: "gh version 2.96.0\n" },
    },
  });
  const code = await runCli(["doctor"], rt);
  assertEquals(code, 0);
  const output = stdout.join("");
  assertMatch(output, /grants file: 1 repo/);
  assertMatch(output, /gh auth git-credential/);
});

Deno.test("doctor: fails when the credential helper is missing", async () => {
  const configDir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${configDir}/grants.json`, JSON.stringify({ "dtinth/claw": "jwt" }));
  const { rt } = makeFakeRuntime({
    env: {
      HOME: "/home/dtinth",
      CLAW_BASE_URL: "https://claw.example.com",
      CLAW_CONFIG_DIR: configDir,
      CLAW_CACHE_DIR: await Deno.makeTempDir(),
    },
    commandOutputs: {
      "git config --global --get-all credential.https://github.com.helper": { code: 1 },
      "gh --version": { code: 0, stdout: "gh version 2.96.0\n" },
    },
  });
  const code = await runCli(["doctor"], rt);
  assertEquals(code, 1);
});

// --- help / unknown --------------------------------------------------------

Deno.test("no command prints help and exits 0", async () => {
  const { rt, stdout } = makeFakeRuntime({ env: {} });
  const code = await runCli([], rt);
  assertEquals(code, 0);
  assertStringIncludes(stdout.join(""), "claw");
});

Deno.test("unknown command exits 1 with help text", async () => {
  const { rt, stderr } = makeFakeRuntime({ env: {} });
  const code = await runCli(["frobnicate"], rt);
  assertEquals(code, 1);
  assertStringIncludes(stderr.join(""), "frobnicate");
});
