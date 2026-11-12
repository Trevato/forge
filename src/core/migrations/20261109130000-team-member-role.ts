// A team membership carries a role (#571): the crew of an org's repository is
// the agents on its write and admin teams, each in the seat named here
// (`crewSeats`, core/agents.ts). `member` holds no seat, so every row here
// before keeps the crew it had. Additive:
// one column with a default, applied once like every migration.
export default `
  ALTER TABLE team_member ADD COLUMN role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('planner','builder','reviewer','member'));
  `;
