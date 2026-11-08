/** Where the pill's tag goes: before the last `</body`, any case, else at the end (#8186). */
import { expect, test } from "bun:test";
import { withToolbar } from "../src/apps/toolbar.ts";

const TAG = `<script src="/__forge/toolbar`;
const put = (html: string): string =>
  new TextDecoder().decode(withToolbar(new TextEncoder().encode(html), "http://f.test"));
/** Where the tag landed, as the text before it. */
const before = (html: string): string => {
  const out = put(html);
  return out.slice(0, out.indexOf(TAG));
};

test("an upper-case </BODY> takes the tag", () => {
  expect(before("<BODY>x</BODY>")).toBe("<BODY>x");
});

test("a mixed-case </Body takes the tag", () => {
  expect(before("<Body>x</Body>")).toBe("<Body>x");
});

test("of two </body the last one wins", () => {
  expect(before("<p></body>a</body>z")).toBe("<p></body>a");
});

test("a page with no </body gets the tag at the end", () => {
  const html = "<p>no close</p> </bod </bodx";
  expect(before(html)).toBe(html);
  expect(put(html).endsWith("</script>")).toBe(true);
});

test("a page shorter than the needle gets the tag at the end", () => {
  expect(before("")).toBe("");
  expect(before("</body")).toBe("");
  expect(before("</bod")).toBe("</bod");
  expect(before("x")).toBe("x");
});

test("</body text inside a script near the end is where the tag goes", () => {
  // The last </body wins, as it always has: a script that writes the text
  // inside a string takes the tag in front of it, still inside the script.
  const html = `<body><script>document.write("</body>")</script></body>`;
  expect(before(html)).toBe(`<body><script>document.write("</body>")</script>`);
  const only = `<body><script>var s = "</body>"</script>`;
  expect(before(only)).toBe(`<body><script>var s = "`);
});
