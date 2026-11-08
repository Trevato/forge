import { expect, test } from "bun:test";
import { sideOf, type SidePreview } from "../src/apps/side.ts";

const app = { url: "https://lab--forge.example" };
const p = (number: number, state: string, title = `t${number}`): SidePreview => ({
  number,
  title,
  state,
  url: `https://lab--${number}--forge.example`,
});

test("a preview points at production's recorded address", () => {
  expect(sideOf(app, "pull-7", [p(7, "running")])).toEqual({ label: "Open on production", url: app.url });
});

test("production points at the highest running or asleep preview", () => {
  expect(sideOf(app, "production", [p(3, "running"), p(9, "asleep", "Nine"), p(5, "running")])).toEqual({
    label: "Newest preview: #9 Nine",
    url: "https://lab--9--forge.example",
  });
});

test("production with no previews has no other side", () => {
  expect(sideOf(app, "production", [])).toBeNull();
});

test("stopped, failed and deploying previews are skipped", () => {
  expect(sideOf(app, "production", [p(4, "running"), p(8, "stopped"), p(9, "failed"), p(10, "deploying")])?.url).toBe(
    "https://lab--4--forge.example",
  );
  expect(sideOf(app, "production", [p(8, "stopped")])).toBeNull();
});

test("a long pull title is clipped so the label stays one line", () => {
  const label = sideOf(app, "production", [p(2, "running", "x".repeat(200))])?.label ?? "";
  expect(label).toBe(`Newest preview: #2 ${"x".repeat(31)}…`);
});
