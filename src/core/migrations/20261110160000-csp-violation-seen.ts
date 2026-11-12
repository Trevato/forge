// When a CSP violation row was last counted (#10906), in epoch ms, so an
// agent reads the newest blocked host per directive and a window of hours,
// not only of UTC days. Rows already kept are dated the end of their day. Additive.
export default `
  ALTER TABLE csp_violation ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;
  UPDATE csp_violation SET seen = (unixepoch(day) + 86399) * 1000;
  `;
