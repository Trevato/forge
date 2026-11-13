// `app_domain.old_records` (#11719): the DNS records the name carried before an own-domain
// cut-over, as a JSON array a person wrote down, kept with the row so the way back is one read.
// Additive: one column, empty until someone records them.
export default `
  ALTER TABLE app_domain ADD COLUMN old_records TEXT NOT NULL DEFAULT '[]';
  `;
