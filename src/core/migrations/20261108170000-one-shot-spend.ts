// What each one-shot question to the model cost (#9569): the data explorer's
// fallback runs on the asker's account, so its spend counts toward their daily
// ceiling (`daySpent`). A row is written with the run's cap before it starts,
// so asks under way are counted, and set to the real cost when it ends. Additive.
export default `
  CREATE TABLE one_shot_spend (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    subscription_id TEXT NOT NULL,
    cost_usd        REAL NOT NULL DEFAULT 0,
    at              TEXT NOT NULL
  );
  CREATE INDEX one_shot_spend_user_at ON one_shot_spend (user_id, at);
  `;
