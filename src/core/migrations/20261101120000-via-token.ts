// Every event written while a conversation's token (`core/via_token.ts`) is
// the caller carries its conversation, so the record says who and how (#7648).
export default `
  ALTER TABLE event ADD COLUMN via TEXT;
  `;
