// The proof before the line is gone (#7779): the pull's check and the merge
// queue's gate run the same command, so a proof proved nothing the gate does
// not. Its ledger rows are deleted with it. The `proof_run` table stays,
// unread: a migration never drops a table across a roll (the release still
// in play reads it), and a later one may once no such release is.
export default `
  DELETE FROM decision WHERE kind = 'proof';
  `;
