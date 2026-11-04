// What the provider measured of a subscription's window (#8960): the percent
// of it used, as the provider reported it with the window's reset. One row
// per subscription and window kind, the newest word replacing the last.
// Additive.
export default `
  CREATE TABLE subscription_measure (
    subscription_id TEXT NOT NULL,
    span TEXT NOT NULL,
    used_pct REAL NOT NULL,
    resets_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (subscription_id, span)
  ) WITHOUT ROWID;
  `;
