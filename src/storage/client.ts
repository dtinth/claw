/**
 * S3-compatible object storage for uploaded files, via `s3-lite-client` (no
 * dependencies, works against any S3-compatible endpoint including MinIO —
 * unlike the full AWS SDK, it doesn't drag in a large dependency tree).
 */
import { S3Client } from "jsr:@bradenmacdonald/s3-lite-client@^0.9";

/** claw's storage surface — just enough to write an uploaded file once. */
export interface StorageClient {
  putObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
}

/** Dependencies for {@link createStorageClient}. */
export interface StorageClientDeps {
  /** Full endpoint URL, e.g. `https://s3.example.com`. */
  endPoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export function createStorageClient(deps: StorageClientDeps): StorageClient {
  const client = new S3Client({
    endPoint: deps.endPoint,
    region: deps.region,
    bucket: deps.bucket,
    accessKey: deps.accessKey,
    secretKey: deps.secretKey,
  });

  return {
    async putObject(key, data, contentType) {
      await client.putObject(key, data, { metadata: { "Content-Type": contentType } });
    },
  };
}
