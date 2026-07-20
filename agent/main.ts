/**
 * claw agent CLI — entry point. Wires {@link Runtime} to real Deno APIs and
 * runs. No import from the server (`../src`) — this is a standalone client
 * that only ever holds a claw JWT, never the app's private key.
 */
import { runCli, type Runtime } from "./cli.ts";

async function runCommand(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const command = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await command.output();
    return {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

async function spawnInteractive(
  cmd: string,
  args: string[],
  envOverrides: Record<string, string>,
): Promise<{ code: number }> {
  const command = new Deno.Command(cmd, {
    args,
    env: envOverrides,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  return { code };
}

/**
 * Read a single line from stdin, stopping at the first `\n` (or EOF) without
 * consuming the rest of the stream. A whole-stdin read would force an
 * interactive paste to end with Ctrl-D even after pressing Enter.
 */
async function readLine(): Promise<string> {
  const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        const newlineIndex = value.indexOf("\n");
        if (newlineIndex !== -1) {
          buffer += value.slice(0, newlineIndex);
          break;
        }
        buffer += value;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return buffer;
}

const encoder = new TextEncoder();

const runtime: Runtime = {
  env: Deno.env.toObject(),
  now: () => new Date(),
  fetch,
  stdout: (text) => Deno.stdout.writeSync(encoder.encode(text)),
  stderr: (text) => Deno.stderr.writeSync(encoder.encode(text)),
  runCommand,
  spawnInteractive,
  readLine,
};

if (import.meta.main) {
  const code = await runCli(Deno.args, runtime);
  Deno.exit(code);
}
