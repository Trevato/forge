// How a release went live (#11955): 'keeper' for one the release keeper cut, 'by hand' for one the
// steward shipped (a tag pushed, an image built on the host, the container restarted with
// FORGE_VERSION and FORGE_COMMIT) that the forge recorded at its own boot. Additive: one column.
export default `
  ALTER TABLE keeper_release ADD COLUMN how TEXT NOT NULL DEFAULT 'keeper';
`;
