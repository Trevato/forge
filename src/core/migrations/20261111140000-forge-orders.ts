// Orders (#11138): a visitor's purchase of a forge. One row from the moment the name is held (pending)
// to the forge being made (spawned) or failing (failed, kept for an admin). The buyer's ticket is kept
// only as a sha256; the claim link is never kept. Additive.
export default `
  CREATE TABLE forge_order (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL,
    email TEXT NOT NULL,
    state TEXT NOT NULL,
    ticket_hash TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    customer_id TEXT NOT NULL DEFAULT '',
    subscription_id TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    hold_until INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    shown_at INTEGER,
    resent_at INTEGER
  );
  CREATE INDEX forge_order_name ON forge_order (name);
  CREATE INDEX forge_order_state ON forge_order (state);
  `;
