/**
 * The sentences a spend window or budget out of range answers with (#5559).
 * The API and MCP read them from here, so every door says the same words.
 */
export const SPEND_WORDS = {
  usdPerMonth: "usdPerMonth is from 0.01 to 10000 dollars",
  ceilings: "dailyUsd and perRunUsd are each from 0.01 to 10000 dollars, or both null",
  inviteDays: "days is a whole number from 1 to 30",
} as const;
