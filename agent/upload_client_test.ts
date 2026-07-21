import { assertEquals, assertRejects } from "@std/assert";
import { createUploadClient, UploadClientError } from "./upload_client.ts";

interface Recorded {
  url: string;
  headers: Headers;
  form: FormData;
}

function fakeFetch(handler: (req: Recorded) => Response) {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const form = await new Request(url, init).formData();
    const recorded: Recorded = { url, headers: new Headers(init?.headers), form };
    calls.push(recorded);
    return handler(recorded);
  };
  return { fn, calls };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("upload sends the claw JWT as a bearer token and the file as multipart", async () => {
  const { fn, calls } = fakeFetch(() =>
    json({ url: "https://im.example.com/ipfs/bafy/x.png", cid: "bafy" })
  );
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });

  const result = await client.upload({
    jwt: "the.claw.jwt",
    data: new TextEncoder().encode("pixels"),
    filename: "x.png",
  });

  assertEquals(result, { url: "https://im.example.com/ipfs/bafy/x.png", cid: "bafy" });
  assertEquals(calls[0]!.url, "https://claw.example.com/api/upload");
  assertEquals(calls[0]!.headers.get("authorization"), "Bearer the.claw.jwt");
  const file = calls[0]!.form.get("file") as File;
  assertEquals(file.name, "x.png");
  assertEquals(new TextDecoder().decode(await file.arrayBuffer()), "pixels");
});

Deno.test("upload strips a trailing slash from the base URL", async () => {
  const { fn, calls } = fakeFetch(() => json({ url: "u", cid: "c" }));
  const client = createUploadClient({ baseUrl: "https://claw.example.com/", fetch: fn });
  await client.upload({ jwt: "jwt", data: new Uint8Array(), filename: "x.png" });
  assertEquals(calls[0]!.url, "https://claw.example.com/api/upload");
});

Deno.test("upload throws UploadClientError with the status on a 401", async () => {
  const { fn } = fakeFetch(() => json({ error: "token has expired" }, 401));
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.upload({ jwt: "expired.jwt", data: new Uint8Array(), filename: "x.png" }),
    UploadClientError,
    "token has expired",
  );
  assertEquals(error.status, 401);
});

Deno.test("upload throws UploadClientError with the status on a 503", async () => {
  const { fn } = fakeFetch(() => json({ error: "upload storage is not configured" }, 503));
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.upload({ jwt: "jwt", data: new Uint8Array(), filename: "x.png" }),
    UploadClientError,
  );
  assertEquals(error.status, 503);
});

Deno.test("upload falls back to the HTTP status when the body has no error field", async () => {
  const { fn } = fakeFetch(() => new Response("", { status: 500 }));
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.upload({ jwt: "jwt", data: new Uint8Array(), filename: "x.png" }),
    UploadClientError,
    "500",
  );
  assertEquals(error.status, 500);
});

Deno.test("upload throws a status-less UploadClientError on a network failure", async () => {
  const fn = (): Promise<Response> => {
    throw new TypeError("network error");
  };
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });
  const error = await assertRejects(
    () => client.upload({ jwt: "jwt", data: new Uint8Array(), filename: "x.png" }),
    UploadClientError,
  );
  assertEquals(error.status, undefined);
});

Deno.test("upload throws when the response shape is unexpected", async () => {
  const { fn } = fakeFetch(() => json({ notUrl: "nope" }));
  const client = createUploadClient({ baseUrl: "https://claw.example.com", fetch: fn });
  await assertRejects(
    () => client.upload({ jwt: "jwt", data: new Uint8Array(), filename: "x.png" }),
    UploadClientError,
    "unexpected",
  );
});
