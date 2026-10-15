// 71 — an optional Anthropic-compatible API base URL on a subscription
// (`core/subscriptions.ts`): OpenRouter and other gateways, plain text
// (not a secret). Empty means Anthropic's own endpoint.
export default `
  ALTER TABLE subscription ADD COLUMN api_base TEXT;
  `;
