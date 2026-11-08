// The release keeper records each release's worst event-loop stall in its first
// five minutes (#8848), ms, beside the probes' worst latency.
export default `
  ALTER TABLE keeper_release ADD COLUMN worst_stall_ms INTEGER NOT NULL DEFAULT 0;
`;
