import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { shellJs } from "../src/web/client";
import { components } from "../src/web/style/components";

// The real shell script, run in a happy-dom page that carries the palette's markup.
function page() {
  const w: any = new Window({ url: "http://localhost/", width: 390, height: 844 });
  const d = w.document;
  d.body.innerHTML = `<button id="opener" data-palette>Search</button>
    <dialog id="palette"><input class="palette-input"><div class="palette-list"></div>
    <div class="palette-foot"><button data-palette-close type="button">Close</button></div></dialog>
    <script id="palette-index" type="application/json">{"items":[]}</script>`;
  const dlg: any = d.getElementById("palette");
  dlg.showModal = () => dlg.setAttribute("open", "");
  dlg.close = () => { dlg.removeAttribute("open"); dlg.dispatchEvent(new w.Event("close")); };
  dlg.getBoundingClientRect = () => ({ left: 20, right: 370, top: 0, bottom: 400 });
  w.matchMedia = () => ({ matches: false, addEventListener() {} });
  w.fetch = () => new Promise(() => {});
  new Function("document", "window", "location", "sessionStorage", "localStorage", "CSS", "navigator", shellJs)(
    d, w, w.location, w.sessionStorage, w.localStorage, undefined, w.navigator);
  const opener = d.getElementById("opener");
  opener.focus();
  opener.click();
  const press = (el: any, type: string, x: number, y: number) => {
    const e: any = new w.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    el.dispatchEvent(e);
  };
  const tap = (el: any, x: number, y: number) => { press(el, "pointerdown", x, y); press(el, "click", x, y); };
  return { d, dlg, opener, press, tap, w };
}

test("opening the palette opens the dialog", () => {
  expect(page().dlg.hasAttribute("open")).toBe(true);
});

test("a click or tap on the backdrop closes it and the focus goes back", () => {
  const p = page();
  p.tap(p.dlg, 5, 600);
  expect(p.dlg.hasAttribute("open")).toBe(false);
  expect(p.d.activeElement).toBe(p.opener);
});

test("a drag that began inside and ended on the backdrop does not close it", () => {
  const p = page();
  p.press(p.d.querySelector(".palette-input"), "pointerdown", 100, 20);
  p.press(p.dlg, "click", 5, 600);
  expect(p.dlg.hasAttribute("open")).toBe(true);
});

test("a click inside the dialog's own box does not close it", () => {
  const p = page();
  p.tap(p.dlg, 100, 100);
  expect(p.dlg.hasAttribute("open")).toBe(true);
});

test("the Close button closes it", () => {
  const p = page();
  p.press(p.d.querySelector("[data-palette-close]"), "click", 100, 300);
  expect(p.dlg.hasAttribute("open")).toBe(false);
});

test("Escape closes it", () => {
  const p = page();
  p.dlg.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(p.dlg.hasAttribute("open")).toBe(false);
});

test("the visual viewport sizes the sheet, and the sizing is removed on close", () => {
  const w: any = new Window({ url: "http://localhost/" });
  const listeners: Record<string, () => void> = {};
  const vv: any = { offsetTop: 0, height: 400, addEventListener: (t: string, f: () => void) => (listeners[t] = f), removeEventListener() {} };
  const d = w.document;
  d.body.innerHTML = `<button data-palette>S</button><dialog id="palette"><input class="palette-input"><div class="palette-list"></div></dialog><script id="palette-index" type="application/json">{"items":[]}</script>`;
  const dlg: any = d.getElementById("palette");
  dlg.showModal = () => dlg.setAttribute("open", "");
  dlg.close = () => { dlg.removeAttribute("open"); dlg.dispatchEvent(new w.Event("close")); };
  w.visualViewport = vv; w.matchMedia = () => ({ matches: false, addEventListener() {} }); w.fetch = () => new Promise(() => {});
  new Function("document", "window", "location", "sessionStorage", "localStorage", "CSS", "navigator", shellJs)(
    d, w, w.location, w.sessionStorage, w.localStorage, undefined, w.navigator);
  d.querySelector("[data-palette]").click();
  expect(dlg.style.getPropertyValue("--vv-h")).toBe("400px");
  vv.height = 300; vv.offsetTop = 12; listeners.resize!();
  expect(dlg.style.getPropertyValue("--vv-h")).toBe("300px");
  expect(dlg.style.getPropertyValue("--vv-top")).toBe("12px");
  dlg.close();
  expect(dlg.style.getPropertyValue("--vv-h")).toBe("");
});

test("the phone sheet's rules come after every base rule they override", () => {
  const sheet = components.indexOf("Last of the palette rules");
  for (const base of [".palette-foot {", ".palette-list {", ".palette-item {", ".palette .palette-input {", ".palette-empty {"]) {
    expect(components.indexOf(base)).toBeGreaterThan(-1);
    expect(components.indexOf(base)).toBeLessThan(sheet);
  }
  expect(components).toContain("html[data-overlay] { overflow: hidden; }");
});
