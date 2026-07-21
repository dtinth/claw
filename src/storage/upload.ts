/**
 * Orchestrates one file upload: validate the filename, compute its IPFS CID
 * (`cid.ts`), store it (`client.ts`) at the same `ipfs/<cid>/<filename>` key
 * `upload-server` uses, and return the public URL.
 */
import { contentType } from "jsr:@std/media-types@^1";
import { computeCid } from "./cid.ts";
import type { StorageClient } from "./client.ts";

export interface UploadResult {
  cid: string;
  key: string;
  url: string;
}

export interface UploadServiceDeps {
  storage: StorageClient;
  /** Public base URL for reading back an uploaded object, no trailing slash. */
  publicUrl: string;
}

export interface UploadService {
  upload(data: Uint8Array, filename: string): Promise<UploadResult>;
}

/** Thrown for a filename that can't safely become part of an object key/URL. */
export class InvalidFilenameError extends Error {
  override name = "InvalidFilenameError";
}

/**
 * Reject anything that isn't a plain single path segment — no empty name, no
 * `/`/`\`, no `.`/`..`, nothing that could escape the `ipfs/<cid>/` prefix or
 * get misread as a directory traversal once it's part of a URL path.
 */
export function validateUploadFilename(filename: string): void {
  if (!filename || filename === "." || filename === "..") {
    throw new InvalidFilenameError(`invalid filename: ${JSON.stringify(filename)}`);
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new InvalidFilenameError(`filename must not contain a path separator: ${filename}`);
  }
}

function guessContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot);
  return contentType(ext) ?? "application/octet-stream";
}

export function createUploadService(deps: UploadServiceDeps): UploadService {
  const publicUrl = deps.publicUrl.replace(/\/$/, "");
  return {
    async upload(data, filename) {
      validateUploadFilename(filename);
      const cid = await computeCid(data, filename);
      const key = `ipfs/${cid}/${filename}`;
      await deps.storage.putObject(key, data, guessContentType(filename));
      return { cid, key, url: `${publicUrl}/${key}` };
    },
  };
}
