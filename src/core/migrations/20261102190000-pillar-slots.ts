// How much each pillar may do at once (#7668): the planner and the reviewer
// get a number beside the builders' `autonomy_slots`, and 0 pauses a pillar
// without taking its agent off the crew. Defaults keep every repository as it
// was: one planning pass, reviews as many as the builders can open (8). Additive.
export default `
  ALTER TABLE repo ADD COLUMN planner_slots INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE repo ADD COLUMN reviewer_slots INTEGER NOT NULL DEFAULT 8;
  `;
