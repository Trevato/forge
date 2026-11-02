// The FLOW ONLY switch left in d34910d4 (#7771), first shipped in v0.7.302;
// nothing since reads `repo.flow_only` or `flow_only_watch` (#8731). Its old
// `flow_only.cleared` events stay as they are, readable in a trail.
// Not additive, on purpose: test/schema-additive.test.ts names it as retired
// and holds the tree to never naming either again.
export default `
  DROP TABLE IF EXISTS flow_only_watch;
  ALTER TABLE repo DROP COLUMN flow_only;
  `;
