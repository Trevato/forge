import { describe, expect, test } from "bun:test";
import { expectAccessible, physicalRules, parse, problems } from "./helper.ts";

describe("ui-spec helper catches what it says it catches", () => {
  test("a control with no name or role", () => {
    expect(problems(`<button class="btn"></button>`).join()).toContain("no accessible name");
    expect(problems(`<div role="" tabindex="0" onclick="x()"></div>`).join()).toContain("no role");
  });
  test("a clickable div needs tabindex and a key handler", () => {
    const p = problems(`<div role="button" onclick="x()">Go</div>`).join();
    expect(p).toContain("no tabindex");
    expect(p).toContain("no key handler");
    expect(problems(`<div role="button" tabindex="0" onclick="x()" onkeydown="x()">Go</div>`, { unsized: ["div"] })).toEqual([]);
  });
  test("a small tap target fails, a 44px one passes", () => {
    expect(problems(`<a class="btn" data-size="sm" href="/">Go</a>`).join()).toContain("36px");
    expect(problems(`<a class="btn" href="/">Go</a>`)).toEqual([]);
  });
  test("left/right in inline style fails", () => {
    expect(problems(`<a href="/" style="margin-left:4px">Go</a>`).join()).toContain("left/right");
    expect(problems(`<a class="btn" href="/" style="margin-inline-start:4px">Go</a>`)).toEqual([]);
  });
  test("labels name inputs", () => {
    expect(problems(`<input id="a" class="input">`).join()).toContain("no accessible name");
    expectAccessible(`<label for="a">Name</label><input id="a" class="input">`);
  });
  test("a control with no size rule fails unless named, and a link in prose is exempt", () => {
    expect(problems(`<div role="button" tabindex="0" onclick="x()" onkeydown="x()">Go</div>`).join()).toContain(
      "no size rule",
    );
    expect(problems(`<a href="/x">Go</a>`).join()).toContain("no size rule");
    expect(problems(`<a href="/x">Go</a>`, { unsized: ["a"] })).toEqual([]);
    expect(problems(`<p>Read the <a href="/docs">docs</a> first.</p>`)).toEqual([]);
  });
  test("right-to-left: a stylesheet rule on a rendered node that names left or right fails", () => {
    const bad = problems(`<select class="input" id="s" name="s"></select><label for="s">K</label>`);
    expect(bad.join()).toContain('stylesheet rule "select.input" hard-codes padding-right');
    // Named on purpose, it passes; a node the rule does not match is not blamed.
    expect(physicalRules(parse(`<select class="input"></select>`), ["select.input"])).toEqual([]);
    expect(physicalRules(parse(`<span class="pill">1</span>`))).toEqual([]);
  });
  test("expectAccessible throws for physical left/right", () => {
    expect(() => expectAccessible(`<a class="btn" href="/" style="float:left">Go</a>`)).toThrow();
  });
});
