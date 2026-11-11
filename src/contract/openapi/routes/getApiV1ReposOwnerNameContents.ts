import { REPO, type Route } from "../shared.ts";

export const route: Route = { method: "get", path: `${REPO}/contents`, summary: "Read the tree or a file at `ref` (default: the default branch); no `path` or a directory answers { type: \"dir\", ref, path, entries }, a file answers { type: \"file\", ref, path, size, encoding: \"utf-8\" | \"base64\", content }, a file over 5 MB is a 413 { type: \"file\", tooLarge: true, size }; a private repository needs a token", auth: false, role: "anonymous", query: { path: "string", ref: "string" } };
