/**
 * Subscriptions' refusal words — the sentences an admin reads when adding,
 * removing or tuning an account is refused. One place, so every door says
 * the same thing: the Subscriptions page reads them all, and a person's own
 * add (`actions/model_grant.ts`, on /settings/model and in the terminal)
 * reads the token and API base sentences. An MCP tool for these reads here.
 */

import { HEADROOM_MAX } from "./standing.ts";
import { NAME_MAX, type SubscriptionError } from "./subscriptions.ts";

export const SUBSCRIPTION_WORDS = {
  invalid_name: `A name is a word or two, up to ${NAME_MAX} characters.`,
  name_taken: (name: string): string =>
    `There is already a subscription called ${name.trim()}.`,
  invalid_token:
    "That token is empty or over 4096 characters once spaces, line breaks and a `Bearer ` prefix are dropped. One from `claude setup-token` begins sk-ant-oat; anything else is taken as an API key (sk-ant-api…, sk-ant-usr…, sk-or-v1-…, or a gateway's own with its base URL).",
  invalid_api_base:
    "The API base URL must be https, with no credentials, query, or hash. For OpenRouter use https://openrouter.ai/api (a Claude subscription token cannot use a gateway).",
  headroom_range: `Headroom is a whole percent from 0 to ${HEADROOM_MAX}.`,
  not_found: "No such subscription.",
  removed:
    "Removed, with its grants. Runs it paid for keep it in their history.",
} as const;

/** The sentence for an add refused with `error`; `name` is what was typed. */
export function addRefusal(error: SubscriptionError, name: string): string {
  return error === "name_taken"
    ? SUBSCRIPTION_WORDS.name_taken(name)
    : SUBSCRIPTION_WORDS[error];
}
