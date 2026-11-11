/** A page with the shell script (`shellJs`) running over given markup in happy-dom; `store` seeds the tab's sessionStorage. */
import { shellJs } from "../../src/web/client.ts";

export async function shellPage(path: string, body: string, store: Record<string, string> = {}) {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: `http://forge.test${path}` });
  for (const [k, v] of Object.entries(store)) win.sessionStorage.setItem(k, v);
  win.document.body.innerHTML = body;
  (win.HTMLElement.prototype as any).scrollIntoView ??= () => {};
  const assigned: string[] = [];
  const loc = new Proxy(win.location, {
    get: (t, k) => (k === "assign" ? (u: string) => void assigned.push(u) : (t as any)[k]),
  });
  new Function("document", "window", "location", "sessionStorage", "CSS", "fetch", "EventSource", shellJs)(
    win.document, win, loc, win.sessionStorage, { escape: (x: string) => x.replace(/([^\w-])/g, "\\$1") },
    async () => ({ ok: false, status: 500, text: async () => "", headers: { get: () => null } }), undefined,
  );
  const doc = win.document as any;
  const key = (k: string, target: unknown = doc) => {
    const e = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    (target as any).dispatchEvent(e);
    return e;
  };
  /** The hrefs the Enter key clicks while the click is cancelled. */
  const clicks: string[] = [];
  doc.addEventListener("click", (e: any) => { clicks.push(e.target.getAttribute("href")); e.preventDefault(); }, true);
  /** The href of the link inside (or being) the focused data-nav row, or null when focus is not on a row. */
  const focusedRow = () => {
    const row = doc.activeElement?.closest?.("[data-nav]");
    return row ? (row.matches("a") ? row : row.querySelector("a"))?.getAttribute("href") ?? null : null;
  };
  return { win, doc, key, assigned, clicks, focusedRow };
}

/** What a list owes the shell: j/k walk `hrefs`, Enter opens the focused one, no key fires in a field, and Esc on the opened page returns. */
export async function expectListKeys(opts: { path: string; html: string; hrefs: string[]; opened: { path: string; body: string } | null }) {
  const { expect } = await import("bun:test");
  const p = await shellPage(opts.path, opts.html + "<input id=f>");
  const rows = [...p.doc.querySelectorAll("[data-nav]")];
  expect(rows.length).toBe(opts.hrefs.length);
  p.key("j");
  expect(p.focusedRow()).toBe(opts.hrefs[0]!);
  expect(p.doc.activeElement).toBe(rows[0]); // the row itself carries the focus marker
  p.key("j");
  expect(p.focusedRow()).toBe(opts.hrefs[1] ?? opts.hrefs[0]!);
  p.key("k");
  expect(p.focusedRow()).toBe(opts.hrefs[0]!);
  p.key("Enter");
  expect(p.clicks).toEqual([opts.hrefs[0]!]);
  const stored = JSON.parse(p.win.sessionStorage.getItem("nav-from")!);
  expect(stored).toMatchObject({ list: opts.path, href: opts.hrefs[0]! });

  // In a field no key moves, opens or leaves.
  const field = p.doc.getElementById("f") as any;
  field.focus();
  const before = p.clicks.length;
  p.key("j", field); p.key("Enter", field);
  expect(p.doc.activeElement).toBe(field);
  expect(p.clicks.length).toBe(before);

  // Esc on the page that was opened goes back to this list.
  // `opened: null` is a list whose links lead to a page that is itself a list: nowhere to return to.
  if (!opts.opened) {
    const same = await shellPage(opts.path, opts.html, { "nav-from": JSON.stringify(stored) });
    same.key("Escape");
    expect(same.assigned).toEqual([]);
    return;
  }
  const back = await shellPage(opts.opened.path, opts.opened.body, { "nav-from": JSON.stringify(stored) });
  const e = back.key("Escape");
  expect(back.assigned).toEqual([opts.path]);
  expect(e.defaultPrevented).toBe(true);
}

/** The part of a rendered page worth driving: its <main>, scripts removed. */
export function mainOf(page: string): string {
  const at = page.indexOf("<main");
  const end = page.lastIndexOf("</main>");
  return (at >= 0 && end > at ? page.slice(at, end + 7) : page).replace(/<script[\s\S]*?<\/script>/g, "");
}

/** The hrefs of the links the shell would walk, read from parsed markup rather than attribute order. */
export async function navHrefs(markup: string): Promise<string[]> {
  const { Window } = await import("happy-dom");
  const doc = new Window({ url: "http://forge.test/" }).document as any;
  doc.body.innerHTML = markup;
  return [...doc.querySelectorAll("[data-nav]")].map((r: any) => (r.matches("a") ? r : r.querySelector("a"))?.getAttribute("href"));
}
