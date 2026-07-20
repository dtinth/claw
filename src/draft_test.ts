import { assertEquals } from "@std/assert";
import { parseDraftParams } from "./draft.ts";

function parse(query: string) {
  return parseDraftParams(new URLSearchParams(query));
}

Deno.test("parseDraftParams reads an issue draft", () => {
  const result = parse("repo=dtinth/claw&issue=42&body=Nice+work");
  assertEquals(result, {
    value: { repo: "dtinth/claw", target: { kind: "issue", issueNumber: 42 }, body: "Nice work" },
  });
});

Deno.test("parseDraftParams reads a discussion draft with optional replyTo", () => {
  const result = parse("repo=o/r&discussion=3&replyTo=DC_abc&body=Hi");
  assertEquals(result, {
    value: {
      repo: "o/r",
      target: { kind: "discussion", discussionNumber: 3, replyToId: "DC_abc" },
      body: "Hi",
    },
  });
});

Deno.test("parseDraftParams allows an empty body (form can be filled in)", () => {
  const result = parse("repo=o/r&issue=1");
  assertEquals("value" in result && result.value.body, "");
});

Deno.test("parseDraftParams rejects a missing/invalid repo", () => {
  assertEquals("error" in parse("issue=1&body=x"), true);
  assertEquals("error" in parse("repo=not-a-repo&issue=1"), true);
});

Deno.test("parseDraftParams rejects when neither issue nor discussion is given", () => {
  assertEquals("error" in parse("repo=o/r&body=x"), true);
});

Deno.test("parseDraftParams rejects a non-positive issue number", () => {
  assertEquals("error" in parse("repo=o/r&issue=0"), true);
  assertEquals("error" in parse("repo=o/r&issue=abc"), true);
});
