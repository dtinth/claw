import { assertEquals, assertRejects } from "@std/assert";
import { ClaudeCredentialsError, readClaudeAccessToken } from "./claude_credentials.ts";

async function withCredsFile(content: string | undefined, fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/.credentials.json`;
  try {
    if (content !== undefined) await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readClaudeAccessToken extracts claudeAiOauth.accessToken", async () => {
  await withCredsFile(
    JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-fake", expiresAt: 123 } }),
    async (path) => {
      assertEquals(await readClaudeAccessToken(path), "sk-ant-oat-fake");
    },
  );
});

Deno.test("readClaudeAccessToken throws ClaudeCredentialsError when the file is missing", async () => {
  await assertRejects(
    () => readClaudeAccessToken("/no/such/path/.credentials.json"),
    ClaudeCredentialsError,
    "no such",
  );
});

Deno.test("readClaudeAccessToken throws on invalid JSON", async () => {
  await withCredsFile("not json", async (path) => {
    await assertRejects(() => readClaudeAccessToken(path), ClaudeCredentialsError, "JSON");
  });
});

Deno.test("readClaudeAccessToken throws when claudeAiOauth.accessToken is missing", async () => {
  await withCredsFile(JSON.stringify({ claudeAiOauth: {} }), async (path) => {
    await assertRejects(() => readClaudeAccessToken(path), ClaudeCredentialsError, "accessToken");
  });
});

Deno.test("readClaudeAccessToken throws when claudeAiOauth is missing entirely", async () => {
  await withCredsFile(JSON.stringify({}), async (path) => {
    await assertRejects(() => readClaudeAccessToken(path), ClaudeCredentialsError);
  });
});
