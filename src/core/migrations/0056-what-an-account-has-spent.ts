// 56 — what an account has spent, in a counter that only grows (#601's
// review): summing its runs let a deleted repository (its runs cascade)
// refill a budget. A trigger adds every increase in a run's cost to its
// account, so no route through the run table can take spend back; the
// counter starts from the runs there are today. A run that moves to
// another account brings its whole cost along: counted twice, never lost.
export default `
  ALTER TABLE subscription ADD COLUMN spent_usd REAL NOT NULL DEFAULT 0;
  UPDATE subscription SET spent_usd = (
    SELECT COALESCE(SUM(r.cost_usd), 0) FROM run r WHERE r.subscription_id = subscription.id
  );
  CREATE TRIGGER IF NOT EXISTS run_spend_to_subscription
  AFTER UPDATE OF cost_usd, subscription_id ON run
  WHEN NEW.subscription_id IS NOT NULL
  BEGIN
    UPDATE subscription SET spent_usd = spent_usd + (
      CASE WHEN OLD.subscription_id IS NEW.subscription_id
           THEN MAX(0, NEW.cost_usd - OLD.cost_usd)
           ELSE NEW.cost_usd END)
    WHERE id = NEW.subscription_id;
  END;
  CREATE TRIGGER IF NOT EXISTS run_spend_on_insert
  AFTER INSERT ON run
  WHEN NEW.subscription_id IS NOT NULL AND NEW.cost_usd > 0
  BEGIN
    UPDATE subscription SET spent_usd = spent_usd + NEW.cost_usd WHERE id = NEW.subscription_id;
  END;
  `;
