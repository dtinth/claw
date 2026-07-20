/**
 * claw — server entry point.
 *
 * Loads configuration from the environment, opens the KV store, builds the
 * GitHub client and the Hono app, and starts listening.
 */
import { loadConfig } from "./config.ts";
import { createGitHubClient } from "./github/client.ts";
import { createGristClient } from "./grist/client.ts";
import { createApp } from "./web/app.ts";

export function main(): void {
  const config = loadConfig(Deno.env.toObject());
  const github = createGitHubClient({
    appId: config.appId,
    privateKeyPem: config.privateKeyPem,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const grist = config.grist ? createGristClient(config.grist) : undefined;
  const app = createApp({ config, github, ...(grist ? { grist } : {}) });

  Deno.serve({ port: config.port, hostname: "0.0.0.0" }, app.fetch);
  console.log(
    `claw listening on :${config.port} (base URL ${config.baseUrl}, user @${config.allowedLogin}` +
      `, comment relay ${grist ? "enabled" : "disabled"})`,
  );
}

if (import.meta.main) {
  main();
}
