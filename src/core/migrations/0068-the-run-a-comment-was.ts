// 68 — the run a comment was said into as it worked (#827): its agent heard
// it then, so the next run's brief does not tell it again.
export default `
  ALTER TABLE comment ADD COLUMN heard_in TEXT;
  `;
