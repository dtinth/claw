/**
 * Reads the local file `claw upload` sends. A thin wrapper over `Deno.readFile`
 * so a missing/unreadable path gets a message worth printing to stderr instead
 * of a raw `Deno.errors.*` dump.
 */

export class LocalFileError extends Error {
  override name = "LocalFileError";
}

export async function readLocalFile(path: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new LocalFileError(`no such file: ${path}`);
    }
    if (error instanceof Deno.errors.IsADirectory) {
      throw new LocalFileError(`is a directory, not a file: ${path}`);
    }
    throw new LocalFileError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The filename portion of a path (the part after the last `/`). */
export function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}
