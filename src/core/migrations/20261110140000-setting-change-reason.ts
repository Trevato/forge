// A capacity change keeps why beside who (#10778): cells.egress moves to
// report only with a reason, and the change log shows it. Additive.
export default `
  ALTER TABLE forge_setting_change ADD COLUMN reason TEXT NOT NULL DEFAULT '';
  `;
