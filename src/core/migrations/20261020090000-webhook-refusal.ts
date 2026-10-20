// Why a webhook delivery was not sent at all (#2992): "refused: private
// address" is no response status, so it has a column of its own.
export default `
  ALTER TABLE webhook_delivery ADD COLUMN last_error TEXT;
  `;
