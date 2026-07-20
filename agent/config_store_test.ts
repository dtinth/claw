import { assertEquals, assertRejects } from "@std/assert";
import {
  ConfigFileMissingError,
  ConfigStoreError,
  loadConfig,
  loadConfigOrEmpty,
  setBaseUrl,
} from "./config_store.ts";

async function withTempFile(content: string | undefined, fn: (path: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.json`;
  try {
    if (content !== undefined) await Deno.writeTextFile(path, content);
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadConfig parses a valid config file", async () => {
  await withTempFile(JSON.stringify({ baseUrl: "https://claw.example.com" }), async (path) => {
    const config = await loadConfig(path);
    assertEquals(config.baseUrl, "https://claw.example.com");
  });
});

Deno.test("loadConfig throws ConfigFileMissingError when the file is missing", async () => {
  await withTempFile(undefined, async (path) => {
    await assertRejects(() => loadConfig(path), ConfigFileMissingError);
  });
});

Deno.test("loadConfig throws a ConfigStoreError on invalid JSON", async () => {
  await withTempFile("not json", async (path) => {
    await assertRejects(() => loadConfig(path), ConfigStoreError);
  });
});

Deno.test("loadConfig throws a ConfigStoreError when baseUrl isn't a non-empty string", async () => {
  await withTempFile(JSON.stringify({ baseUrl: 123 }), async (path) => {
    await assertRejects(() => loadConfig(path), ConfigStoreError);
  });
});

Deno.test("loadConfig tolerates an empty object (no baseUrl configured yet)", async () => {
  await withTempFile(JSON.stringify({}), async (path) => {
    const config = await loadConfig(path);
    assertEquals(config.baseUrl, undefined);
  });
});

Deno.test("loadConfigOrEmpty returns {} when the file is missing", async () => {
  await withTempFile(undefined, async (path) => {
    assertEquals(await loadConfigOrEmpty(path), {});
  });
});

Deno.test("loadConfigOrEmpty still throws on a malformed existing file", async () => {
  await withTempFile("not json", async (path) => {
    await assertRejects(() => loadConfigOrEmpty(path), ConfigStoreError);
  });
});

Deno.test("setBaseUrl creates the file and directory when neither exists", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/nested/config.json`;
    await setBaseUrl(path, "https://claw.example.com");
    const config = await loadConfig(path);
    assertEquals(config.baseUrl, "https://claw.example.com");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("setBaseUrl overwrites a previously configured value", async () => {
  await withTempFile(JSON.stringify({ baseUrl: "https://old.example.com" }), async (path) => {
    await setBaseUrl(path, "https://new.example.com");
    const config = await loadConfig(path);
    assertEquals(config.baseUrl, "https://new.example.com");
  });
});
