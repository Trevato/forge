/** A fake document and window to boot the toolbar script in, shared by the toolbar tests. */

import { toolbarJs } from "../../src/apps/toolbar.ts";

type L = Record<string, ((e?: any) => void)[]>;
interface El {
  tag: string;
  style: Record<string, string>;
  children: El[];
  listeners: L;
  hidden: boolean;
  textContent: string;
  [k: string]: any;
}
const make = (tag: string): El => ({
  tag,
  style: {},
  children: [],
  listeners: {},
  hidden: false,
  textContent: "",
  attrs: {} as Record<string, string>,
  setAttribute(k: string, v: string) { this.attrs[k] = v; },
  removeAttribute(k: string) { delete this.attrs[k]; },
  appendChild(c: El) { this.children.push(c); return c; },
  addEventListener(t: string, f: (e?: any) => void) { (this.listeners[t] ??= []).push(f); },
  focus() {},
  attachShadow() { return make("shadow"); },
});
const all = (el: El): El[] => [el, ...el.children.flatMap(all)];

export function boot(store: Record<string, string> | null, width = 400, height = 800, dataset: Record<string, string> = { app: "notes", env: "production" }) {
  let root!: El;
  const host = { el: null as El | null };
  const doc = {
    currentScript: { src: "https://forge.test/assets/t.js", dataset },
    createElement: (tag: string) => {
      const el = make(tag);
      if (tag === "div" && !host.el) {
        host.el = el;
        el.attachShadow = () => (root = make("shadow"));
      }
      return el;
    },
    addEventListener() {},
    body: { appendChild() {} },
  };
  const win: Record<string, any> = { innerWidth: width, innerHeight: height };
  if (store)
    win.localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
  new Function("window", "document", "URL", toolbarJs)(win, doc, URL);
  const els = all(root);
  const pill = els.find((e) => e.tag === "button")!;
  const box = root.children[0]!;
  const panel = els.find((e) => e.attrs.role === "region")!;
  const fire = (el: El, t: string, e: object = {}) => el.listeners[t]!.forEach((f) => f({ preventDefault() {}, type: t, ...e }));
  return { host: host.el!, pill, box, panel, fire, texts: () => all(panel).map((e) => e.textContent).filter(Boolean) };
}
