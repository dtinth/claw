import { assertEquals, assertRejects } from "@std/assert";
import { basename, LocalFileError, readLocalFile } from "./local_file.ts";

Deno.test("readLocalFile reads an existing file's bytes", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/hello.txt`;
    await Deno.writeTextFile(path, "hello world");
    const data = await readLocalFile(path);
    assertEquals(new TextDecoder().decode(data), "hello world");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLocalFile throws LocalFileError for a missing path", async () => {
  await assertRejects(
    () => readLocalFile("/no/such/path/does-not-exist.png"),
    LocalFileError,
    "no such file",
  );
});

Deno.test("readLocalFile throws LocalFileError for a directory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => readLocalFile(dir), LocalFileError, "directory");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("basename returns the part after the last slash", () => {
  assertEquals(basename("/a/b/c.png"), "c.png");
  assertEquals(basename("c.png"), "c.png");
  assertEquals(basename("a/b/"), "");
});
