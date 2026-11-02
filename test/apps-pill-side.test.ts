/**
 * The pill's link to the other side (#6269): its origin joined to this page's
 * path and query as text, so a `//` path stays on the other side; drawn only
 * for an https `side.url` or one on the page's own scheme; nothing without a side.
 */

import { describe, expect, test } from "bun:test";
import { toolbarJs } from "../src/apps/toolbar.ts";

type El = {
  tag: string;
  children: El[];
  style: Record<string, string>;
  dataset?: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
};

function el(tag: string): El {
  const e: El = {
    tag,
    children: [],
    style: {},
    appendChild(c: El) { e.children.push(c); return c; },
    setAttribute() {},
    addEventListener() {},
    attachShadow() { return e.appendChild(el("root")); },
  };
  return e;
}

function walk(e: El, out: El[] = []): El[] {
  out.push(e);
  for (const c of e.children) walk(c, out);
  return out;
}

async function run(side: unknown, loc: { protocol: string; pathname: string; search: string }) {
  const doc = {
    ...el("document"),
    currentScript: {
      src: "https://forge.test/assets/toolbar.js",
      dataset: { app: "lab", env: "production" },
      removeAttribute() {},
    },
    createElement: el,
    body: el("body"),
  } as unknown as El;
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, location: g.location, fetch: g.fetch, window: g.window };
  const win = { innerWidth: 800, innerHeight: 600, localStorage: { getItem: () => null, setItem() {} } };
  g.window = win;
  g.document = doc;
  g.location = { ...loc, origin: "https://app.test", href: "https://app.test" + loc.pathname + loc.search };
  g.fetch = async () => ({ ok: true, json: async () => ({ side }) });
  try {
    new Function("window", "document", "location", "fetch", toolbarJs)(win, doc, g.location, g.fetch);
    await new Promise((r) => setTimeout(r, 5));
    return walk(doc.body)
      .filter((e) => e.tag === "a" && e.href && e.textContent === "Other")
      .map((e) => e.href as string);
  } finally {
    Object.assign(g, saved);
  }
}

const https = { protocol: "https:", pathname: "/a/b", search: "?x=1" };

describe("the pill's other side", () => {
  test("joins the other origin to this path and query", async () => {
    expect(await run({ label: "Other", url: "https://other.test/ignored?y=2" }, https)).toEqual([
      "https://other.test/a/b?x=1",
    ]);
  });

  test("a // path stays on the other side's origin", async () => {
    const [href] = await run({ label: "Other", url: "https://other.test/" }, { ...https, pathname: "//evil.test/x", search: "" });
    expect(new URL(href!).origin).toBe("https://other.test");
  });

  test("no side, no link", async () => {
    expect(await run(undefined, https)).toEqual([]);
  });

  test("http is drawn only on an http page", async () => {
    expect(await run({ label: "Other", url: "http://other.test" }, https)).toEqual([]);
    expect(await run({ label: "Other", url: "http://other.test" }, { ...https, protocol: "http:" })).toEqual([
      "http://other.test/a/b?x=1",
    ]);
  });
});
