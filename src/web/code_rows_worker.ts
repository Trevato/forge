/** The worker side of `code_rows_pool.ts`: lay out rows, or encode a finished page. */
import { compressBytes, type Encoding } from "../http/compress.ts";
import { codeRows } from "./code_rows.ts";

declare const self: Worker;

export type Job =
  | { id: number; kind: "rows"; body: Uint8Array; path: string; limit: number }
  | { id: number; kind: "encode"; body: Uint8Array<ArrayBuffer>; encoding: Encoding };

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    if (job.kind === "rows") {
      const text = new TextDecoder().decode(job.body).replace(/\n$/, "");
      postMessage({ id: job.id, result: codeRows(text, job.path, job.limit) });
    } else {
      postMessage({ id: job.id, result: compressBytes(job.body, job.encoding) });
    }
  } catch (error) {
    postMessage({ id: job.id, error: String(error) });
  }
};
