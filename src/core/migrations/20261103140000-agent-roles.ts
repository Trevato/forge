// An agent's roles are its own config (#8907): the seats it can hold, planner,
// builder, reviewer, one or more, comma-joined in that order. Existing agents
// take the roles they hold today on any repository, so nothing changes under
// them; an agent on no crew keeps `builder`, which is what it read as. Additive.
export default `
  ALTER TABLE agent ADD COLUMN roles TEXT NOT NULL DEFAULT 'builder';
  UPDATE agent SET roles = rtrim(
    (CASE WHEN EXISTS (SELECT 1 FROM repo_crew WHERE user_id = agent.user_id AND role = 'planner') THEN 'planner,' ELSE '' END) ||
    (CASE WHEN EXISTS (SELECT 1 FROM repo_crew WHERE user_id = agent.user_id AND role = 'builder') THEN 'builder,' ELSE '' END) ||
    (CASE WHEN EXISTS (SELECT 1 FROM repo_crew WHERE user_id = agent.user_id AND role = 'reviewer') THEN 'reviewer,' ELSE '' END), ',')
  WHERE EXISTS (SELECT 1 FROM repo_crew WHERE user_id = agent.user_id);
  `;
