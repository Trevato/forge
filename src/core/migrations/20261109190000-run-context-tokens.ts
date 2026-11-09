// A finished agent run keeps the context its session held at the end: what
// the last assistant message read, from Claude Code's usage. The resume
// gate (`crew/resume.ts`) reads it to tell a short session from a long one
// instead of guessing from turns and cost. 0 for every run from before, and
// for one that reported none. Additive.
export default `
  ALTER TABLE run ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
  `;
