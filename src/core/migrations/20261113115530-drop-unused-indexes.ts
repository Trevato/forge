// Seven indexes no statement the forge prepares plans through (#12011, part of #11973:
// indexes are most of forge.db). `bun scripts/index-use.ts --unused` finds them: every SQL
// text under src/ and in the triggers, EXPLAIN QUERY PLAN on a fresh schema; the forge never
// runs ANALYZE, so production plans the same way. None is UNIQUE, partial, a foreign key's
// lookup or named by code. Each table's reads already walk another index or the key:
// session by session_user, storage by storage_at, webhook_delivery by delivery_state_id,
// note_shipped by its key, the rest read whole or by id. Writes stop paying for them.
// Additive: an old process plans the same statements without them.
export default `
  DROP INDEX IF EXISTS flow_valve_turn_at;
  DROP INDEX IF EXISTS gift_redeem_code;
  DROP INDEX IF EXISTS note_shipped_pull;
  DROP INDEX IF EXISTS session_seen;
  DROP INDEX IF EXISTS storage_repo;
  DROP INDEX IF EXISTS telemetry_read_at;
  DROP INDEX IF EXISTS delivery_due;
  `;
