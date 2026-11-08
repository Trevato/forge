import { expect, test } from "bun:test";
import { isLocalPath } from "../src/web/flash.ts";
import { backTo, type Form } from "../src/web/form.ts";

const refused: [string, string][] = [
  ["protocol-relative", "//evil.example"],
  ["backslash after slash", "/\\evil.example"],
  ["absolute URL", "https://evil.example"],
  ["javascript scheme", "javascript:alert(1)"],
  ["bare host", "evil.example/x"],
  ["empty", ""],
  ["tab", "/a\tb"],
  ["newline", "/a\nb"],
  ["NUL", "/a\u0000b"],
  ["backslash inside", "/a/b\\c"],
  ["trailing backslash", "/a\\"],
  ["leading space", " /a"],
  ["513 characters", "/" + "a".repeat(512)],
];

const accepted: [string, string][] = [
  ["root", "/"],
  ["query and fragment", "/a/b?c=d#e"],
  ["encoded slashes", "/%2F%2Fx"],
  ["encoded backslash (the guard does not decode)", "/%5Cevil"],
  ["512 characters", "/" + "a".repeat(511)],
];

function formWith(back: string): Form {
  const form = new FormData();
  form.set("back", back);
  return form as unknown as Form;
}

test("the guard refuses every off-origin value", () => {
  for (const [name, value] of refused)
    expect([name, isLocalPath(value)]).toEqual([name, false]);
});

test("the guard accepts same-origin paths", () => {
  for (const [name, value] of accepted)
    expect([name, isLocalPath(value)]).toEqual([name, true]);
});

test("backTo returns the fallback for each refused value", () => {
  for (const [name, value] of refused)
    expect([name, backTo(formWith(value), "/fallback")]).toEqual([
      name,
      "/fallback",
    ]);
});

test("backTo returns each accepted value itself", () => {
  for (const [name, value] of accepted)
    expect([name, backTo(formWith(value), "/fallback")]).toEqual([name, value]);
});

test("backTo returns the fallback when the form has no back field", () => {
  expect(backTo(new FormData() as unknown as Form, "/fallback")).toBe(
    "/fallback",
  );
});
