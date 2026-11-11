// How long the failed attempt of a flaked test took (#7560): the rule watcher
// reads the p95 of a budget test's attempts to say how much headroom it lacks.
// Null for rows written before this column. Additive.
export default `
  ALTER TABLE check_flake ADD COLUMN ms INTEGER;
  `;
