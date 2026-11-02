// When a standing clog really began (#6757), epoch ms, beside `since` (when it
// was declared). Zero means not recorded: the clog began when it was declared.
export default `
  ALTER TABLE clog_state ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
`;
