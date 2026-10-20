// What `webspec()` found on a preview once it was live (#2955), kept per
// deploy run so the pull page can show it beside the check. Report-only: a
// row never changes a run's state. Gone with its run.
export default `
  CREATE TABLE preview_finding (
    run_id   TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    findings TEXT NOT NULL
  );
  `;
