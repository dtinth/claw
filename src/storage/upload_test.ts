import { assertEquals, assertRejects } from "@std/assert";
import { createUploadService, InvalidFilenameError, type UploadService } from "./upload.ts";
import type { StorageClient } from "./client.ts";

interface PutCall {
  key: string;
  data: Uint8Array;
  contentType: string;
}

function fakeStorage(): { storage: StorageClient; calls: PutCall[] } {
  const calls: PutCall[] = [];
  return {
    storage: {
      putObject: (key, data, contentType) => {
        calls.push({ key, data, contentType });
        return Promise.resolve();
      },
    },
    calls,
  };
}

function makeService(
  publicUrl = "https://im.example.com",
): { service: UploadService; calls: PutCall[] } {
  const { storage, calls } = fakeStorage();
  return { service: createUploadService({ storage, publicUrl }), calls };
}

Deno.test("upload stores the file under ipfs/<cid>/<filename> and returns the public URL", async () => {
  const { service, calls } = makeService();
  const data = new TextEncoder().encode("hello world\n");

  const result = await service.upload(data, "hello.txt");

  assertEquals(result.cid, "bafybeidhkumeonuwkebh2i4fc7o7lguehauradvlk57gzake6ggjsy372a");
  assertEquals(result.key, `ipfs/${result.cid}/hello.txt`);
  assertEquals(result.url, `https://im.example.com/ipfs/${result.cid}/hello.txt`);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.key, result.key);
  assertEquals(calls[0]!.data, data);
});

Deno.test("upload guesses the content type from the filename extension", async () => {
  const { service, calls } = makeService();
  await service.upload(new TextEncoder().encode("<html></html>"), "page.html");
  assertEquals(calls[0]!.contentType, "text/html; charset=UTF-8");
});

Deno.test("upload falls back to application/octet-stream for an unknown extension", async () => {
  const { service, calls } = makeService();
  await service.upload(new Uint8Array([1, 2, 3]), "data.unknownext");
  assertEquals(calls[0]!.contentType, "application/octet-stream");
});

Deno.test("upload strips a trailing slash from the configured public URL", async () => {
  const { service } = makeService("https://im.example.com/");
  const result = await service.upload(new TextEncoder().encode("x"), "x.txt");
  assertEquals(result.url, `https://im.example.com/ipfs/${result.cid}/x.txt`);
});

Deno.test("upload rejects an empty filename", async () => {
  const { service } = makeService();
  await assertRejects(() => service.upload(new Uint8Array(), ""), InvalidFilenameError);
});

Deno.test("upload rejects . and ..", async () => {
  const { service } = makeService();
  await assertRejects(() => service.upload(new Uint8Array(), "."), InvalidFilenameError);
  await assertRejects(() => service.upload(new Uint8Array(), ".."), InvalidFilenameError);
});

Deno.test("upload rejects a filename containing a path separator", async () => {
  const { service } = makeService();
  await assertRejects(
    () => service.upload(new Uint8Array(), "../../etc/passwd"),
    InvalidFilenameError,
  );
  await assertRejects(() => service.upload(new Uint8Array(), "a/b.txt"), InvalidFilenameError);
  await assertRejects(() => service.upload(new Uint8Array(), "a\\b.txt"), InvalidFilenameError);
});
