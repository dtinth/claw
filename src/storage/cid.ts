/**
 * IPFS content-identifier calculation for uploaded files, via `@thai/carify`
 * (an in-memory-only, no-network build of the same unixfs/CAR logic
 * `dtinth/upload-server` uses). Given the same bytes and filename, this
 * always returns the same CID — the property that lets an uploaded file also
 * be fetched from any IPFS gateway if it's ever pinned there.
 */
import { carify } from "jsr:@thai/carify@^0.0.4";

/** The CID of `buffer` as a single file named `filename` in a unixfs directory. */
export async function computeCid(buffer: Uint8Array, filename: string): Promise<string> {
  const { cid } = await carify(buffer, filename);
  return cid;
}
