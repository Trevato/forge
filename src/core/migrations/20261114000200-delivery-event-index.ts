// Old events are pruned in batches (`system/retention_events.ts`, #12008), and `webhook_delivery`
// cascades from `event`: without an index on `event_id` every deleted event scans the deliveries.
// One index makes the cascade a lookup. Additive.
export default `
  CREATE INDEX IF NOT EXISTS delivery_event ON webhook_delivery(event_id);
`;
