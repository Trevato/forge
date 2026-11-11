/**
 * Which payment provider this forge sells through: `stripe` or `none`
 * (`FORGE_BILLING_PROVIDER`; anything else reads as `none`). With `none`
 * nothing is charged, so pages show the plans without prices.
 */

export type BillingProvider = "none" | "stripe";

export function billingProvider(env: Record<string, string | undefined> = process.env): BillingProvider {
  return env["FORGE_BILLING_PROVIDER"] === "stripe" ? "stripe" : "none";
}
