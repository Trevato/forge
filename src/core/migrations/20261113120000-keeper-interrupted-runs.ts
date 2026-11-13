// The switch disturbs nothing (#11839, #11917): each release counts the crew runs that were running in the
// process it drained, so the target of zero is measured first. Null for a release that did not count them.
// Additive: one new nullable column.
export default `
  ALTER TABLE keeper_release ADD COLUMN interrupted_runs INTEGER;
`;
