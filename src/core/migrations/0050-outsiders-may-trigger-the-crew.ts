// 50 — "outsiders may trigger the crew" (#619): off, so only people who
// can write to a repository start or steer its crew.
export default `
  ALTER TABLE repo ADD COLUMN crew_outsiders INTEGER NOT NULL DEFAULT 0;
  `;
