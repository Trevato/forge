// What a /talk turn's session had in its context at the end (#8822): the last
// message's input tokens and the model's window, both from the run's own usage
// record; 0 when none came.
export default `
  ALTER TABLE conversation_run ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversation_run ADD COLUMN context_window INTEGER NOT NULL DEFAULT 0;
  `;
