// 10 — a short link for a connect in flight.
//
// The device grant asks a person to open a URL on a *different* device. In
// a browser that is a link; in a terminal over SSH it is a string nobody
// can click, copy reliably, or retype without error. So a flow gets a
// 10-character code (50 bits of crypto randomness, unguessable within the
// ten minutes it lives) that `/go/<code>` redirects to, which is short
// enough to type by hand and to fit in a version 1–3 QR code.
//
// `target_enc` is where it redirects, sealed like every other secret this
// table holds: for a code flow that URL carries the `state`, and the whole
// point of storing the state as a digest is that a database read hands
// nobody a usable one.
export default `
  ALTER TABLE oauth_flow ADD COLUMN short_code TEXT;
  ALTER TABLE oauth_flow ADD COLUMN target_enc TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX oauth_flow_short ON oauth_flow(short_code);
  `;
