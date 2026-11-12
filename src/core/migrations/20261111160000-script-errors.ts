// Uncaught script errors the page-view beacon reports (#11447): one count per
// UTC hour, page, script path, line and message. Bounded per day by
// `recordScriptError` (src/http/script_errors.ts). Additive.
export default `
  CREATE TABLE script_error (
    day  TEXT NOT NULL,
    page TEXT NOT NULL,
    src  TEXT NOT NULL,
    line INTEGER NOT NULL,
    msg  TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, page, src, line, msg)
  ) WITHOUT ROWID;
  `;
