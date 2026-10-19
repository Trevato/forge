// Each agent run records the model it ran on and a version of the prompt it
// was given (a hash of the brief and the system prompt), so the crew
// scorecard can read per model and per prompt version (#2682).
export default `
  ALTER TABLE run ADD COLUMN model TEXT NOT NULL DEFAULT '';
  ALTER TABLE run ADD COLUMN prompt_version TEXT NOT NULL DEFAULT '';
  `;
