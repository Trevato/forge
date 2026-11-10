/** The changelog joins the shell's j/k row traversal: one data-nav per landing row, none when nothing shipped. */
import { expect, test } from "bun:test";
import type { Landing, Landings } from "../src/release/landings.ts";
import { shippedRegion } from "../src/web/pages/changelog.ts";

const l = (number: number, live: boolean): Landing => ({ repo: "a/b", number, title: `Pull ${number}`, at: "2026-03-05T10:00:00Z", live });
const read = (live: Landing[], onItsWay: Landing[]): Landings => ({ version: "1.0.0", commit: null, own: "a/b", live, onItsWay });
const NAV = /class="row"[^>]*data-nav tabindex="-1"/g;

test("every landing row, live or on its way, is one data-nav row", () => {
  const text = String(shippedRegion(read([l(1, true), l(2, true)], [l(3, false)]), "a/b"));
  expect(text.match(NAV)?.length).toBe(3);
});

test("a changelog with nothing shipped draws no data-nav row", () => {
  const text = String(shippedRegion(read([], []), "a/b"));
  expect(text).toContain("Nothing has shipped yet");
  expect(text).not.toContain("data-nav");
});
