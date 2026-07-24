/**
 * Reads the OAuth access token Claude Code itself uses, from its local
 * credentials file — the same token `claw usage-report` presents to
 * Anthropic's usage endpoint. Never sent to claw's server; only the
 * percentages derived from it are.
 */

export class ClaudeCredentialsError extends Error {
  override name = "ClaudeCredentialsError";
}

/** Default path to Claude Code's credentials file, given `HOME`. */
export function defaultClaudeCredentialsPath(home: string): string {
  return `${home}/.claude/.credentials.json`;
}

export async function readClaudeAccessToken(path: string): Promise<string> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new ClaudeCredentialsError(
        `no such file: ${path} — is Claude Code installed and logged in?`,
      );
    }
    throw new ClaudeCredentialsError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ClaudeCredentialsError(`${path} is not valid JSON`);
  }

  const token = (data as { claudeAiOauth?: { accessToken?: unknown } } | null)?.claudeAiOauth
    ?.accessToken;
  if (typeof token !== "string" || !token) {
    throw new ClaudeCredentialsError(`${path} has no claudeAiOauth.accessToken`);
  }
  return token;
}
