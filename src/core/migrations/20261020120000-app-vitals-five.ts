// An app keeps the same five numbers the forge's own pages do (#3200):
// ttfb, lcp and cls join load and inp. Additive, and nullable: a row from
// before reads null for the three, and no p75 counts it.
export default `
  ALTER TABLE app_vital ADD COLUMN ttfb REAL;
  ALTER TABLE app_vital ADD COLUMN lcp REAL;
  ALTER TABLE app_vital ADD COLUMN cls REAL;
  `;
