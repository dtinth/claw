import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { ConfigError, loadConfig, normalizePrivateKey } from "./config.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n";

function fullEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_PRIVATE_KEY: PEM,
    GITHUB_CLIENT_ID: "Iv1.abc",
    GITHUB_CLIENT_SECRET: "clientsecret",
    CLAW_JWT_SECRET: "jwtsecret",
    BASE_URL: "https://claw.example.com/",
    ...overrides,
  };
}

Deno.test("loadConfig reads a full environment and applies defaults", () => {
  const config = loadConfig(fullEnv());
  assertEquals(config.appId, "123456");
  assertEquals(config.clientId, "Iv1.abc");
  assertEquals(config.baseUrl, "https://claw.example.com"); // trailing slash trimmed
  assertEquals(config.allowedLogin, "dtinth"); // default
  assertEquals(config.port, 8000); // default
  assertStringIncludes(config.privateKeyPem, "BEGIN RSA PRIVATE KEY");
  // webhook + Grist are optional and absent by default
  assertEquals(config.webhookSecret, undefined);
  assertEquals(config.grist, undefined);
});

Deno.test("loadConfig reads optional webhook secret and Grist config", () => {
  const config = loadConfig(fullEnv({
    GITHUB_WEBHOOK_SECRET: "whsec",
    GRIST_API_URL: "https://grist.example.com/api/docs/abc123/",
    GRIST_API_KEY: "gristkey",
  }));
  assertEquals(config.webhookSecret, "whsec");
  assertEquals(config.grist, {
    apiUrl: "https://grist.example.com/api/docs/abc123", // trailing slash trimmed
    apiKey: "gristkey",
    table: "Comments", // default
  });
});

Deno.test("loadConfig honours GRIST_TABLE_ID override", () => {
  const config = loadConfig(fullEnv({
    GRIST_API_URL: "https://grist.example.com/api/docs/abc123",
    GRIST_API_KEY: "gristkey",
    GRIST_TABLE_ID: "Messages",
  }));
  assertEquals(config.grist?.table, "Messages");
});

Deno.test("loadConfig requires GRIST_API_KEY when GRIST_API_URL is set", () => {
  assertThrows(
    () => loadConfig(fullEnv({ GRIST_API_URL: "https://grist.example.com/api/docs/abc123" })),
    ConfigError,
    "GRIST_API_KEY",
  );
});

Deno.test("loadConfig defaults oauthScopes to public_repo, overridable", () => {
  assertEquals(loadConfig(fullEnv()).oauthScopes, "public_repo");
  assertEquals(loadConfig(fullEnv({ GITHUB_OAUTH_SCOPES: "repo" })).oauthScopes, "repo");
  assertEquals(loadConfig(fullEnv({ GITHUB_OAUTH_SCOPES: "" })).oauthScopes, "");
});

Deno.test("loadConfig honours ALLOWED_LOGIN and PORT overrides", () => {
  const config = loadConfig(fullEnv({ ALLOWED_LOGIN: "someone", PORT: "3000" }));
  assertEquals(config.allowedLogin, "someone");
  assertEquals(config.port, 3000);
});

Deno.test("loadConfig aggregates all missing required variables", () => {
  const error = assertThrows(
    () => loadConfig({ GITHUB_APP_ID: "1" }),
    ConfigError,
  ) as ConfigError;
  assertStringIncludes(error.message, "GITHUB_APP_PRIVATE_KEY");
  assertStringIncludes(error.message, "CLAW_JWT_SECRET");
  assertStringIncludes(error.message, "BASE_URL");
});

Deno.test("loadConfig rejects a malformed BASE_URL", () => {
  assertThrows(
    () => loadConfig(fullEnv({ BASE_URL: "not a url" })),
    ConfigError,
    "BASE_URL",
  );
});

Deno.test("loadConfig rejects a non-numeric PORT", () => {
  assertThrows(
    () => loadConfig(fullEnv({ PORT: "eighty" })),
    ConfigError,
    "PORT",
  );
});

Deno.test("normalizePrivateKey converts escaped newlines to real ones", () => {
  const escaped = "-----BEGIN KEY-----\\nabc\\n-----END KEY-----";
  const result = normalizePrivateKey(escaped);
  assertStringIncludes(result, "\n");
  assertEquals(result.includes("\\n"), false);
});

Deno.test("normalizePrivateKey decodes a base64-wrapped PEM", () => {
  const b64 = btoa(PEM);
  const result = normalizePrivateKey(b64);
  assertStringIncludes(result, "BEGIN RSA PRIVATE KEY");
});
