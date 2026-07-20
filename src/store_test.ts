import { assertEquals, assertRejects } from "@std/assert";
import { openStore } from "./store.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("createDraft and getDraft round-trip", async () => {
  const store = await openStore(":memory:");
  try {
    const draft = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 7 },
      body: "Nice work!",
    });
    assertEquals(draft.status, "pending");
    assertEquals(draft.repo, "dtinth/claw");

    const fetched = await store.getDraft(draft.id);
    assertEquals(fetched?.body, "Nice work!");
    assertEquals(fetched?.target, { kind: "issue", issueNumber: 7 });
  } finally {
    store.close();
  }
});

Deno.test("getDraft returns null for an unknown id", async () => {
  const store = await openStore(":memory:");
  try {
    assertEquals(await store.getDraft("nope"), null);
  } finally {
    store.close();
  }
});

Deno.test("listDrafts returns drafts newest first", async () => {
  const store = await openStore(":memory:");
  try {
    const first = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 1 },
      body: "first",
    });
    await delay(5);
    const second = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "discussion", discussionNumber: 2 },
      body: "second",
    });

    const list = await store.listDrafts();
    assertEquals(list.map((d) => d.id), [second.id, first.id]);
  } finally {
    store.close();
  }
});

Deno.test("updateDraft merges a patch", async () => {
  const store = await openStore(":memory:");
  try {
    const draft = await store.createDraft({
      repo: "dtinth/claw",
      target: { kind: "issue", issueNumber: 7 },
      body: "hi",
    });
    const updated = await store.updateDraft(draft.id, {
      status: "posted",
      postedUrl: "https://github.com/dtinth/claw/issues/7#issuecomment-1",
    });
    assertEquals(updated.status, "posted");
    assertEquals(updated.postedUrl, "https://github.com/dtinth/claw/issues/7#issuecomment-1");
    assertEquals((await store.getDraft(draft.id))?.status, "posted");
  } finally {
    store.close();
  }
});

Deno.test("updateDraft rejects an unknown id", async () => {
  const store = await openStore(":memory:");
  try {
    await assertRejects(() => store.updateDraft("nope", { status: "posted" }), Error, "not found");
  } finally {
    store.close();
  }
});

Deno.test("session put/get/delete round-trip", async () => {
  const store = await openStore(":memory:");
  try {
    await store.putSession("sid-1", {
      login: "dtinth",
      accessToken: "gho_xxx",
      createdAt: new Date().toISOString(),
    }, 60_000);

    assertEquals((await store.getSession("sid-1"))?.login, "dtinth");

    await store.deleteSession("sid-1");
    assertEquals(await store.getSession("sid-1"), null);
  } finally {
    store.close();
  }
});
