/** `.front-featured` and its parts leave the stylesheet (#5249): no page writes them. */
import { describe, expect, test } from "bun:test";
import { css } from "../src/web/style.ts";
import { content } from "../src/web/style/content.ts";

describe("retired front-featured classes", () => {
  for (const name of ["front-featured", "front-featured-body", "front-featured-look"]) {
    test(`.${name} is not in the stylesheet`, () => {
      expect(content).not.toContain(`.${name}`);
      expect(css).not.toContain(`.${name}`);
    });
  }
});
