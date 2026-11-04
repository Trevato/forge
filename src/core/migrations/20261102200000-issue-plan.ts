// A crew run's plan checklist on its issue (#8707): one row per issue, replaced
// whole at each update. `ask` is what the run needs a person to answer, if
// anything. Read by primary key only. Additive.
export default `
  CREATE TABLE issue_plan (
    issue_id   TEXT PRIMARY KEY,
    run_id     TEXT,
    items      TEXT NOT NULL,
    ask        TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  `;
