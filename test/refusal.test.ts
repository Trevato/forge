import { expect, test } from "bun:test";
import { GENERIC_REFUSAL, refusalText, shownRefusal } from "../src/http/refusal.ts";
import { message } from "../src/tui/screens/common.ts";

test("only a prefixed or built-in guard message is shown (#723)", () => {
  expect(shownRefusal("forge: paused for new accounts")).toBe(
    "forge: paused for new accounts",
  );
  expect(shownRefusal("a thought is never changed")).toBe(
    "a thought is never changed",
  );
  expect(shownRefusal("UNIQUE failed: secret_table.col")).toBe(GENERIC_REFUSAL);
  expect(shownRefusal("Forge: wrong case")).toBe(GENERIC_REFUSAL);
});

test("a terminal action that hits a guard shows the shown text, not the trigger's (#723)", () => {
  const trigger = (text: string) =>
    Object.assign(new Error(text), { code: "SQLITE_CONSTRAINT_TRIGGER" });
  expect(message(trigger("secret_table.col is internal"))).toBe("refused");
  expect(message(trigger("forge: paused for new accounts"))).toBe(
    "forge: paused for new accounts",
  );
  expect(message(new Error("plain failure"))).toBe("plain failure");
  expect(refusalText(new Error("plain failure"))).toBeUndefined();
});
