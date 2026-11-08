// The most the stranded spend reached while a clog stood (#6524), so the
// cleared note can say "at peak" truthfully. Additive; zero before this column.
export default `
  ALTER TABLE clog_state ADD COLUMN peak_usd REAL NOT NULL DEFAULT 0;
  `;
