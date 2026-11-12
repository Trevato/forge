/** `firstView` counts only what a reader sees without a click (#10297). */
import { expect, test } from "bun:test";
import { attentionLine, firstView } from "../src/measure/attention.ts";

const page = (inner: string): string => `<html><body><main>${inner}</main></body></html>`;

test("words, blocks and colours of what is shown", () => {
  const v = firstView(page(`<h1>One answer</h1><p>Two words <span data-variant="success">ok</span></p>`), 1280);
  expect(v).toEqual({ words: 5, blocks: 2, colours: 1 });
});

test("hidden, screen-reader, script and closed details are not seen", () => {
  const html = page(
    `<p hidden>a b c</p><p class="sr-only">d e</p><script>var x = 1 2 3</script>` +
      `<details><summary>More</summary><p>deep detail here</p></details>` +
      `<details open><summary>Open</summary><p>shown now</p></details>`,
  );
  expect(firstView(html, 1280)).toEqual({ words: 4, blocks: 3, colours: 0 });
});

test("the width decides what the stylesheet hides", () => {
  const html = page(`<p class="hide-sm">wide only</p><p class="hide-lg">narrow only now</p>`);
  expect(firstView(html, 390).words).toBe(3);
  expect(firstView(html, 1280).words).toBe(2);
});

test("neutral variants are not colours; styled colours are", () => {
  const v = firstView(page(`<span data-variant="secondary">a</span><i style="color:#f00">b</i><i style="color: #F00">c</i>`), 390);
  expect(v.colours).toBe(1);
});

test("bare text directly inside a closed details is not seen", () => {
  const html = page(`<details><summary>More</summary>loose hidden words</details><details open><summary>Open</summary>loose shown</details>`);
  expect(firstView(html, 1280).words).toBe(4);
});

test("the --attention line carries path, status and both widths", () => {
  const line = JSON.parse(attentionLine("/x", 200, page(`<p>one two</p>`)));
  expect(line).toEqual({ path: "/x", status: 200, firstView: { 390: { words: 2, blocks: 1, colours: 0 }, 1280: { words: 2, blocks: 1, colours: 0 } } });
});

test("data-status counts as a colour", () => {
  expect(firstView(page(`<i data-status="failed">x</i>`), 390).colours).toBe(1);
});
