import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/contents/{path}`, summary: "Read a path at `ref` (default: the default branch): a directory answers { type: dir, ref, path, entries }, a file { type: file, ref, path, size, encoding, content } (utf-8, or base64 for binary); a file over 5 MB answers 413 { type: file, tooLarge, size }; 404 for an unsafe ref or path or one that is missing", auth: false, query: { ref: "string" } };
