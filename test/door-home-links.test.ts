import { expect, test } from "bun:test";
import { doorPage, DOOR_PULL_LIMIT, type DoorPullLine } from "../src/apps/door.ts";

const forgeUrl = "https://forge.test";
const pulls: DoorPullLine[] = Array.from({ length: DOOR_PULL_LIMIT + 1 }, (_, i) => ({
  number: i + 1,
  title: "t",
  check: "pass",
  href: `https://forge.test/o/n/pulls/${i + 1}`,
}));
const render = (repo: string | undefined) =>
  doorPage({ where: { app: "a", env: "production", ...(repo === undefined ? {} : { repo }) }, forgeUrl, pulls }, false).text();

test("a reader sees Make it yours and a linked more-pulls line", async () => {
  const html = await render("o/n");
  expect(html).toContain('<a href="https://forge.test/o/n/make-it-yours">Make it yours</a>');
  expect(html.indexOf("The repository")).toBeLessThan(html.indexOf("Make it yours"));
  expect(html).toContain('<a href="https://forge.test/o/n/pulls">More pulls are open on the forge.</a>');
});

test("repo names are escaped in the links", async () => {
  const html = await render('o/"><b>');
  expect(html).not.toContain("<b>");
  expect(html).toContain("make-it-yours");
});

test("a guest sees neither link, and the more line stays plain", async () => {
  const html = await render(undefined);
  expect(html).not.toContain("make-it-yours");
  expect(html).not.toMatch(/<a [^>]*>More pulls/);
  expect(html).toContain("<p>More pulls are open on the forge.</p>");
});
