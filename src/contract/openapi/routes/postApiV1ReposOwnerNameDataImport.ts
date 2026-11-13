import { REPO, type Route } from "../shared.ts";

export const route: Route = {
  method: "post",
  path: `${REPO}/data-import`,
  summary:
    "Load a SQL dump (CREATE TABLE, CREATE INDEX, INSERT INTO only; up to 16 MB) into the app's SQLite store and report each table's rows and SHA-256 on the dump side and the store side: { file, statements, tables: [{ table, rows, sha256, store, match }], kept? }; nothing changes unless every table matches; needs an admin token",
  auth: true,
  role: "admin",
  body: { dump: "string", env: "string?", file: "string?", replace: "boolean?" },
  refusals: {
    invalid_dump: "dump is not text (422)",
    no_app: "the repository is not an app (422)",
    invalid_env: "env is production or pull-<number> (422)",
    invalid_file: "file is a name ending in .db (422)",
    empty: "the dump has no statements (422)",
    refused: "a statement is of a kind a dump may not run; its number is named (422)",
    invalid: "SQLite refused a statement; its number is named (422)",
    exists: "the file exists; send replace to keep it as <file>.before-import (409)",
    mismatch: "the store does not match the dump in some table; nothing was changed (409)",
  },
};
