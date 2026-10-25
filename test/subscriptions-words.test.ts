import { describe, expect, test } from "bun:test";
import { ADD_MESSAGES } from "../src/actions/model_grant.ts";
import { HEADROOM_MAX } from "../src/core/standing.ts";
import { NAME_MAX } from "../src/core/subscriptions.ts";
import {
  addRefusal,
  SUBSCRIPTION_WORDS,
} from "../src/core/subscriptions_words.ts";

describe("subscriptions' refusal words", () => {
  test("every key is a non-empty sentence ending in a full stop", () => {
    for (const words of Object.values(SUBSCRIPTION_WORDS)) {
      const sentence = typeof words === "function" ? words("Team") : words;
      expect(sentence.trim().length).toBeGreaterThan(1);
      expect(sentence.endsWith(".")).toBe(true);
    }
  });

  test("the limits are the code's own", () => {
    expect(SUBSCRIPTION_WORDS.invalid_name).toContain(
      `up to ${NAME_MAX} characters`,
    );
    expect(SUBSCRIPTION_WORDS.headroom_range).toContain(
      `0 to ${HEADROOM_MAX}.`,
    );
  });

  test("an add refusal names the taken name, trimmed", () => {
    expect(addRefusal("name_taken", "  Team  ")).toBe(
      "There is already a subscription called Team.",
    );
    expect(addRefusal("invalid_token", "Team")).toBe(
      SUBSCRIPTION_WORDS.invalid_token,
    );
  });

  test("a person's own add says the page's token and API base words", () => {
    expect(ADD_MESSAGES.invalid_token).toBe(SUBSCRIPTION_WORDS.invalid_token);
    expect(ADD_MESSAGES.invalid_api_base).toBe(
      SUBSCRIPTION_WORDS.invalid_api_base,
    );
  });
});
