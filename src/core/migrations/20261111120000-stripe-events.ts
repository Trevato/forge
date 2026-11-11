// Stripe webhook events (#11244): each signed event id is kept once, so a
// replay answers 200 and does nothing; `stripe_hook_refused` counts bad and
// stale signatures per UTC day. Additive.
export default `
  CREATE TABLE stripe_event (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE TABLE stripe_hook_refused (
    day TEXT NOT NULL,
    kind TEXT NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (day, kind)
  );
  `;
