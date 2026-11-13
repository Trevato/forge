import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { overlayHostJs } from "../src/web/overlay_host.ts";
import { sourceFiles } from "../src/design/overlay.ts";

// The real host, run in a happy-dom page at a phone and a desktop size.
function page(width: number, height: number, host = "example.com") {
  const w: any = new Window({ url: `http://${host}/`, width, height });
  const d = w.document;
  d.body.innerHTML = `<button id="a">A</button>
    <dialog id="dlg"><input id="first"><button id="last">Last</button></dialog>
    <details class="menu" id="m1"><summary id="s1">One</summary><div class="menu-panel"><a class="menu-item" href="#x">x</a></div></details>
    <details class="menu" id="m2"><summary id="s2">Two</summary><div class="menu-panel"><a class="menu-item" href="#y">y</a></div></details>`;
  const dlg: any = d.getElementById("dlg");
  dlg.showModal = () => dlg.setAttribute("open", "");
  dlg.close = () => { dlg.removeAttribute("open"); dlg.dispatchEvent(new w.Event("close")); };
  dlg.getBoundingClientRect = () => ({ left: 20, right: width - 20, top: 100, bottom: 400 });
  const warns: string[] = [];
  const con = { warn: (m: string) => warns.push(m) };
  new Function("document", "window", "location", "console", "MutationObserver", `var window_ = window; ${overlayHostJs.replace(/^\s*var overlayHost = /, "var overlayHost = ")}; window.__h = overlayHost;`)(
    d, w, w.location, con, w.MutationObserver);
  const key = (key: string, extra: object = {}) => {
    const e: any = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
    (d.activeElement ?? d.body).dispatchEvent(e);
    return e;
  };
  const tap = (el: any, x: number, y: number) => {
    for (const t of ["pointerdown", "click"]) el.dispatchEvent(new w.MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  return { w, d, dlg, key, tap, warns, host: w.__h, opener: d.getElementById("a") };
}

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
  test(`${width}x${height}: a closed dialog is not open and the page is not locked`, () => {
    const p = page(width, height);
    expect(p.dlg.hasAttribute("open")).toBe(false);
    expect(p.d.documentElement.hasAttribute("data-overlay")).toBe(false);
    expect(p.host.depth()).toBe(0);
  });

  test(`${width}x${height}: Escape closes the dialog and the focus returns to the opener`, () => {
    const p = page(width, height);
    p.opener.focus();
    p.host.open(p.dlg);
    expect(p.d.documentElement.hasAttribute("data-overlay")).toBe(true);
    const e = p.key("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(p.dlg.hasAttribute("open")).toBe(false);
    expect(p.d.activeElement).toBe(p.opener);
    expect(p.d.documentElement.hasAttribute("data-overlay")).toBe(false);
  });

  test(`${width}x${height}: a tap outside closes it; a tap inside does not; a drag out of it does not`, () => {
    const p = page(width, height);
    p.opener.focus();
    p.host.open(p.dlg);
    p.tap(p.dlg, width / 2, 200);
    expect(p.dlg.hasAttribute("open")).toBe(true);
    p.d.getElementById("first").dispatchEvent(new p.w.MouseEvent("pointerdown", { bubbles: true, clientX: 50, clientY: 150 }));
    p.dlg.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true, cancelable: true, clientX: 2, clientY: 700 }));
    expect(p.dlg.hasAttribute("open")).toBe(true);
    p.tap(p.dlg, 2, 700);
    expect(p.dlg.hasAttribute("open")).toBe(false);
    expect(p.d.activeElement).toBe(p.opener);
  });

  test(`${width}x${height}: Tab never leaves an open dialog`, () => {
    const p = page(width, height);
    p.host.open(p.dlg);
    p.d.getElementById("last").focus();
    expect(p.key("Tab").defaultPrevented).toBe(true);
    expect(p.d.activeElement).toBe(p.d.getElementById("first"));
    expect(p.key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(p.d.activeElement).toBe(p.d.getElementById("last"));
    p.opener.focus(); // focus that escaped is pulled back in
    expect(p.key("Tab").defaultPrevented).toBe(true);
    expect(p.dlg.contains(p.d.activeElement)).toBe(true);
  });
}

test("Escape closes only the top layer of the stack", () => {
  const p = page(390, 844);
  const m = p.d.getElementById("m1");
  p.host.open(m);
  p.host.open(p.dlg);
  p.key("Escape");
  expect(p.dlg.hasAttribute("open")).toBe(false);
  expect(m.hasAttribute("open")).toBe(true);
  p.key("Escape");
  expect(m.hasAttribute("open")).toBe(false);
  expect(p.host.depth()).toBe(0);
});

test("a menu: an outside tap closes it, Escape returns the focus to its summary, one is open at a time", () => {
  const p = page(390, 844);
  const m1 = p.d.getElementById("m1"), m2 = p.d.getElementById("m2");
  p.host.open(m1, { opener: p.d.getElementById("s1") });
  p.host.open(m2, { opener: p.d.getElementById("s2") });
  expect(m1.hasAttribute("open")).toBe(false);
  expect(m2.hasAttribute("open")).toBe(true);
  p.tap(p.opener, 5, 5);
  expect(m2.hasAttribute("open")).toBe(false);
  p.d.getElementById("s2").focus();
  p.opener.focus();
  p.host.open(m2, { opener: p.d.getElementById("s2") });
  p.key("Escape");
  expect(p.d.activeElement).toBe(p.d.getElementById("s2"));
});

test("development only: a dialog opened without the host is named", async () => {
  const dev = page(390, 844, "localhost");
  dev.dlg.id = "mine"; dev.dlg.className = "dialog";
  dev.dlg.setAttribute("open", "");
  await new Promise((r) => setTimeout(r, 20)); // real-timer: the host warns from a 0 ms timer inside happy-dom; no clock is injectable there
  expect(dev.warns.some((m) => m.includes("dialog#mine.dialog") && m.includes("without the overlay host"))).toBe(true);
  const prod = page(390, 844);
  prod.dlg.setAttribute("open", "");
  await new Promise((r) => setTimeout(r, 20)); // real-timer: the host warns from a 0 ms timer inside happy-dom; no clock is injectable there
  expect(prod.warns).toEqual([]);
});

test("development only: a menu opened natively is adopted, not warned about", async () => {
  const dev = page(390, 844, "localhost");
  const m: any = dev.d.getElementById("m1");
  m.setAttribute("open", "");
  await new Promise((r) => setTimeout(r, 20)); // real-timer: the observer's callback runs on happy-dom's own queue
  expect(dev.warns).toEqual([]);
  expect(dev.host.isOpen(m)).toBe(true);
});

test("no overlay in src/web carries its own dismissal code", () => {
  const own = /\.showModal\(\)|dialog\.close\(\)|dlg\.close\(\)|details\.menu\[open\][^\n]*removeAttribute|addEventListener\(\s*'cancel'/;
  const offenders: string[] = [];
  for (const f of sourceFiles(process.cwd())) {
    if (f.endsWith("overlay_host.ts")) continue;
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (own.test(line) && !/^\s*(\/\/|\*)/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

test("a closed overlay has no box: the stylesheet never lays out a closed dialog, and the page lock is the host's", () => {
  const css = readFileSync("src/web/style/components.ts", "utf8");
  expect(css).toContain(".dialog[open] { display: flex;");
  expect(css).not.toMatch(/\n\.dialog \{[^}]*display:\s*(flex|block|grid)/);
  expect(css).toContain("html[data-overlay] { overflow: hidden; }");
});
