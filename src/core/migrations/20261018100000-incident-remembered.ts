// A degraded finding remembers the incident it was filed for (#2553): the
// time the cause first opened, and when its closed issue was last told the
// incident goes on. Both are null for every other finding.
export default `
  ALTER TABLE sentinel_finding ADD COLUMN incident TEXT;
  ALTER TABLE sentinel_finding ADD COLUMN commented_at TEXT;
  `;
