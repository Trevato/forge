import { describe, expect, test } from "bun:test";
import { CARD_CSS, CARD_KINDS, CARD_SHELL, SHELL_JS, cardFor } from "../src/web/studio/cards.ts";
import { CARD_PALETTE } from "../src/http/mcp/card_palette.ts";
import { NO_MARKS, mapJson } from "../src/web/pages/map.ts";

class Node {
  children: Node[] = [];
  textContent = "";
  className = "";
  value = "";
  onclick: ((ev?: any) => void) | undefined;
  focused = false;
  constructor(readonly tag: string) {}
  append(...n: Node[]) { this.children.push(...n); }
  replaceChildren(...n: Node[]) { this.children = n; }
  href = "";
  target = "";
  rel = "";
  setAttribute() {}
  focus() { this.focused = true; }
  all(): Node[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

function shell(opts: { handshake?: boolean } = {}) {
  const root = new Node("div");
  const all: any[] = [];
  const posted: any[] = []; // what the card asks the host to do; lifecycle messages are in `all`
  const life = ["ui/initialize", "ui/notifications/initialized", "ui/notifications/size-changed"];
  const parent = { postMessage: (m: any) => { all.push(m); if (!life.includes(m.method)) posted.push(m); } };
  let listener: (e: any) => void = () => {};
  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  const documentElement = { clientWidth: 400, style: { colorScheme: "", setProperty: (k: string, v: string) => (vars[k] = v), removeProperty: (k: string) => delete vars[k] }, setAttribute: (k: string, v: string) => (attrs[k] = v) };
  const box = { height: 100 };
  const body = { getBoundingClientRect: () => ({ height: box.height }) };
  const head = new Node("head");
  const document = {
    getElementById: (id: string) => (id === "card" ? root : null),
    createElement: (t: string) => new Node(t), documentElement, body, head,
  };
  const frames: (() => void)[] = [];
  let resized: () => void = () => {};
  class RO { constructor(f: () => void) { resized = f; } observe() {} }
  new Function("document", "parent", "addEventListener", "requestAnimationFrame", "ResizeObserver", SHELL_JS)(
    document, parent, (_: string, f: (e: any) => void) => (listener = f), (f: () => void) => frames.push(f), RO,
  );
  const send = (data: unknown, source: unknown = parent) => listener({ source, data });
  const frame = () => frames.splice(0).forEach((f) => f());
  const result = (card: unknown) =>
    ({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { card } } });
  const reply = (hostContext: unknown = {}) =>
    send({ jsonrpc: "2.0", id: all.find((m) => m.method === "ui/initialize").id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "t", version: "1" }, hostCapabilities: {}, hostContext } });
  if (opts.handshake !== false) { reply(); frame(); }
  const sizes = () => all.filter((m) => m.method === "ui/notifications/size-changed").map((m) => m.params.height);
  return { root, posted, all, parent, send, result, reply, frame, vars, attrs, box, resized: () => resized(), sizes, head };
}

describe("the card shell", () => {
  test("announces itself, draws with textContent, ignores other sources, posts tools/call", () => {
    const s = shell();
    expect(s.all[0].method).toBe("ui/initialize");
    const card = {
      kind: "run", title: "<b>T</b>", status: "ok",
      rows: [{ label: "<img src=x onerror=1>", value: "v" }],
      actions: [{ label: "Stop", tool: "stop", args: { repo: "a/b", run: "r1" } }],
    };
    s.send(s.result(card), {});
    expect(s.root.children.length).toBe(0);
    s.send(s.result(card));
    const nodes = s.root.all();
    expect(nodes.find((n) => n.tag === "h2")!.textContent).toBe("<b>T</b>");
    expect(nodes.find((n) => n.tag === "dt")!.textContent).toBe("<img src=x onerror=1>");
    nodes.find((n) => n.tag === "button")!.onclick!();
    expect(s.posted[0]).toMatchObject({
      method: "tools/call",
      params: { name: "stop", arguments: { repo: "a/b", run: "r1" } },
    });
  });

  test("the handshake: ui/initialize is a request with an id, initialized follows only the host's reply", () => {
    const s = shell({ handshake: false });
    expect(s.all.map((m) => m.method)).toEqual(["ui/initialize"]);
    expect(s.all[0]).toMatchObject({ jsonrpc: "2.0", params: { protocolVersion: "2026-01-26", appInfo: { name: "forge-card" }, appCapabilities: {} } });
    expect(typeof s.all[0].id).toBe("string");
    s.send({ jsonrpc: "2.0", id: "other", result: {} });
    s.send({ jsonrpc: "2.0", id: s.all[0].id, result: {} }, {}); // not the parent
    s.send({ jsonrpc: "2.0", id: s.all[0].id, result: "nope" });
    expect(s.all.length).toBe(1);
    s.reply({});
    expect(s.all.map((m) => m.method)).toEqual(["ui/initialize", "ui/notifications/initialized"]);
  });

  test("a host that sends no handshake still gets its card drawn", () => {
    const s = shell({ handshake: false });
    s.send(s.result({ kind: "run", title: "T", status: "ok", rows: [], actions: [] }));
    expect(s.root.all().find((n) => n.tag === "h2")!.textContent).toBe("T");
  });

  test("a tool result before the reply is kept; malformed messages are ignored", () => {
    const s = shell({ handshake: false });
    s.send(null); s.send("x"); s.send({ method: "ui/notifications/tool-result" });
    s.send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { card: { title: 1 } } } });
    expect(s.root.all().some((n) => n.tag === "h2")).toBe(false);
    s.send(s.result({ kind: "run", title: "Early", status: "", rows: [], actions: [] }));
    s.reply({ theme: "dark" });
    expect(s.root.all().find((n) => n.tag === "h2")!.textContent).toBe("Early");
    expect(s.attrs["data-theme"]).toBe("dark");
  });

  test("the host's theme and variables apply, later changes too; bad names and values do not", () => {
    const s = shell({ handshake: false });
    s.reply({ theme: "dark", styles: { variables: { "--color-background-primary": "#111", "color": "red", "--x": 5, "--font-sans": "Inter" }, css: { fonts: "@font-face{}" } } });
    expect(s.attrs["data-theme"]).toBe("dark");
    expect(s.vars).toEqual({ "--font-sans": "Inter" }); // a lone background is not a pair that reads: the card's own palette stands
    expect(s.head.children[0]!.textContent).toBe("@font-face{}");
    s.send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light", styles: { variables: { "--color-background-primary": "#fff" } } } });
    expect(s.attrs["data-theme"]).toBe("light");
    expect(s.vars).toEqual({ "--font-sans": "Inter" });
    s.send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } }, {});
    expect(s.attrs["data-theme"]).toBe("light");
  });

  test("a host's colours are used when they read, and dropped when they do not (dark text on a dark surface)", () => {
    const s = shell({ handshake: false });
    s.reply({ theme: "dark", styles: { variables: { "--color-background-primary": "#101010", "--color-text-primary": "#202020" } } });
    expect(s.vars["--c-bg"]).toBeUndefined();
    s.send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { styles: { variables: { "--color-background-primary": "rgb(16, 16, 16)", "--color-text-primary": "#eee", "--color-text-info": "#222" } } } });
    expect(s.vars).toMatchObject({ "--c-bg": "rgb(16, 16, 16)", "--c-fg": "#eee", "--c-link": "#eee" }); // an unreadable link colour falls back to the text colour
    s.send({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { styles: { variables: { "--color-background-primary": "light-dark(#fff,#000)", "--color-text-primary": "#eee" } } } });
    expect(s.vars["--c-bg"]).toBeUndefined();
  });

  test("the card's own palette reads at 4.5:1 in both schemes, and no rule draws a colour outside it", () => {
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const lum = (c: number[]) => { const f = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!; };
    const ratio = (a: string, b: string) => { const x = lum(hex(a)), y = lum(hex(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const t of ["light", "dark"] as const) {
      expect(ratio(CARD_PALETTE[t].fg, CARD_PALETTE[t].bg)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(CARD_PALETTE[t].link, CARD_PALETTE[t].bg)).toBeGreaterThanOrEqual(4.5);
    }
    // Every text-bearing element takes --c-fg or --c-link on --c-bg; no literal colour is set outside the palette lines.
    const outside = CARD_CSS.replace(/--c-(bg|fg|link):#[0-9a-f]{6}/g, "");
    expect(outside).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(outside.match(/(?<![-\w])color:[^;}]+/g)!.every((d) => d === "color:var(--c-fg)" || d === "color:var(--c-link)")).toBe(true);
    expect(CARD_CSS).toContain("min-height:44px");
  });

  test("an empty result is one short line; more than ten rows show ten and a button for the rest", () => {
    const s = shell();
    const empty = cardFor("search", { repos: [], issues: [], code: [] }, "https://f.test", { q: "zzz" })!;
    expect(empty.rows).toEqual([]);
    expect(empty.status).toBe("No results for “zzz”. Try fewer or different words, or name a repository.");
    s.send(s.result(empty));
    expect(s.root.all().some((n) => n.tag === "dl")).toBe(false);
    expect(s.root.children.length).toBe(2);
    const rows = Array.from({ length: 17 }, (_, i) => ({ label: `r${i}`, value: "v" }));
    s.send(s.result({ kind: "search", title: "Search: x", status: "17 hits", rows, actions: [] }));
    expect(s.root.all().filter((n) => n.tag === "dt").length).toBe(10);
    const more = s.root.all().find((n) => n.tag === "button")!;
    expect(more.textContent).toBe("Show 7 more");
    more.onclick!();
    expect(s.root.all().filter((n) => n.tag === "dt").length).toBe(17);
    expect(s.root.all().some((n) => n.tag === "button")).toBe(false);
  });

  test("host fonts keep only @font-face blocks: an @import or a stray rule is dropped", () => {
    const s = shell({ handshake: false });
    s.reply({ styles: { css: { fonts: '@import url(https://evil.test/x.css);@font-face{font-family:A;src:url(https://h.test/a.woff2)}body{background:url(https://evil.test/b)}' } } });
    expect(s.head.children[0]!.textContent).toBe("@font-face{font-family:A;src:url(https://h.test/a.woff2)}");
  });

  test("Show more keeps the words typed in the field", () => {
    const s = shell();
    const rows = Array.from({ length: 12 }, (_, i) => ({ label: `r${i}`, value: "v" }));
    s.send(s.result({ kind: "apps", title: "t", status: "s", rows, actions: [{ label: "Tell", tool: "tell", args: { repo: "a/b" }, words: true }] }));
    const input = s.root.all().find((n) => n.tag === "input")!;
    input.value = "keep me";
    s.root.all().find((n) => n.textContent === "Show 2 more")!.onclick!();
    expect(s.root.all().filter((n) => n.tag === "dt").length).toBe(12);
    const after = s.root.all().find((n) => n.tag === "input")!;
    expect(after).toBe(input);
    expect(after.value).toBe("keep me");
  });

  test("height is the body box, reported on load, growth and shrink, once a frame", () => {
    const s = shell();
    expect(s.sizes()).toEqual([100]);
    s.box.height = 300; s.resized(); s.resized(); s.resized();
    s.frame();
    expect(s.sizes()).toEqual([100, 300]);
    s.box.height = 120; s.resized(); s.frame();
    expect(s.sizes()).toEqual([100, 300, 120]);
    s.resized(); s.frame(); // unchanged: nothing sent
    expect(s.sizes().length).toBe(3);
  });

  test("after the handshake is answered, every kind is drawn and the theme applied", () => {
    for (const kind of CARD_KINDS) {
      const s = shell({ handshake: false });
      const card = { kind, title: `Card ${kind}`, status: "s", rows: [{ label: "l", value: "v" }], actions: [] };
      expect(s.all[0].method).toBe("ui/initialize");
      s.reply({ theme: "dark" });
      expect(s.all.some((m) => m.method === "ui/notifications/initialized")).toBe(true);
      s.send(s.result(card));
      expect(s.root.all().find((n) => n.tag === "h2")!.textContent).toBe(`Card ${kind}`);
      expect(s.attrs["data-theme"]).toBe("dark");
    }
  });

  test("the served page for every kind wears the host's variables", () => {
    for (const kind of CARD_KINDS) {
      const page = CARD_SHELL(kind);
      expect(page).toContain("color:var(--c-fg)");
      expect(page).toContain("prefers-color-scheme:dark");
      expect(page).toContain("ui/initialize");
    }
  });

  test("Tell sends the typed words, and nothing when empty", () => {
    const s = shell();
    const app = cardFor("apps", [{ app: "alice/game", live: "up" }])!;
    s.send(s.result(app));
    const input = s.root.all().find((n) => n.tag === "input")!;
    const tell = s.root.all().find((n) => n.tag === "button")!;
    tell.onclick!();
    expect(s.posted.length).toBe(0);
    expect(input.focused).toBe(true);
    input.value = " make it blue ";
    tell.onclick!();
    expect(s.posted[0].params).toEqual({
      name: "tell",
      arguments: { repo: "alice/game", context: { said: "make it blue" }, text: "make it blue" },
    });
  });

  test("an ask whose words are markup reaches the page only as text, and a collapsed parked row has no button", () => {
    const s = shell();
    const evil = "<script>alert(1)</script>";
    const row = (kind: string, items: string[], line: string) =>
      ({ line, kind, items, repo: "a/b", number: 1, numberOf: "issue", words: { decision: evil, options: [evil] } });
    s.send(s.result(cardFor("asks", { rows: [row("parked", ["p:1"], evil), row("parked", ["p:1", "p:2"], "many"), row("look", ["l:1"], "l")] })!));
    const nodes = s.root.all();
    const dts = nodes.filter((n) => n.tag === "dt");
    expect(dts[0]!.textContent).toBe(evil);
    expect(nodes.filter((n) => n.tag === "dd")[0]!.textContent).toContain(evil);
    // Only createElement'd text nodes: no node is a script, and no tag carries the markup.
    expect(nodes.some((n) => n.tag === "script")).toBe(false);
    expect(nodes.filter((n) => n.tag === "button").map((b) => b.textContent)).toEqual(["Decide", "Ship"]);
    expect(nodes.some((n) => n.tag === "input")).toBe(false);
  });

  test("the map draws a Plan card from what mapJson returns: one count per issue, agreeing everywhere", () => {
    const mk = (number: number, state = "open") =>
      ({ id: `i${number}`, number, title: `T<${number}>`, state, closeReason: null, assigneeName: null, createdAt: `2026-01-${String(number).padStart(2, "0")}` }) as never;
    // 1 umbrella (P0), 2-8 P0 work (3 is the crew's, 4 held), 9-10 P1 (10 waits on 9), 11 done.
    const issues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => mk(n, n === 11 ? "closed" : "open"));
    const graph = {
      issues,
      edges: [{ issueId: "i10", blockedById: "i9" }],
      held: [],
      unadopted: new Set(),
      structural: new Set(["i1"]),
      deferred: new Map(),
    } as never;
    const marks = { ...NO_MARKS, crew: new Map([["i3", {}]]), onHold: new Map([["i4", "a pull"]]) } as never;
    const of = new Map<string, string>([...[2, 3, 4, 5, 6, 7, 8].map((n) => [`i${n}`, "P0"] as const), ["i9", "P1"], ["i10", "P1"]]);
    const pillars = {
      set: { pillars: [{ name: "P0", umbrella: issues[0] }, { name: "P1", umbrella: mk(12) }], gate: undefined, later: undefined },
      names: ["P0", "P1"], of, merged: [],
    } as never;
    const json = mapJson({ ownerName: "a", name: "b", crewOutsiders: false } as never, graph, marks, pillars);
    const card = cardFor("map", json, "https://f.example")!;
    expect(card.title).toBe("Plan");
    expect(card.status).toBe("6 ready · 1 working · 1 waiting");
    expect(card.rows.slice(0, 2)).toEqual([
      { label: "P0", value: "5 ready · 1 working · 0 waiting" },
      { label: "P1", value: "1 ready · 0 working · 1 waiting" },
    ]);
    // The headline is the sum of the rows.
    const sum = (i: number) => card.rows.slice(0, 2).reduce((n, r) => n + Number(r.value.split(" ")[i === 0 ? 0 : i === 1 ? 3 : 6]), 0);
    expect(`${sum(0)} ready · ${sum(1)} working · ${sum(2)} waiting`).toBe(card.status);
    // Nothing the crew is on, or a person holds, is offered as ready; five at most.
    const links = card.rows.slice(2);
    expect(links.map((r) => r.label)).toEqual(["#9", "#2", "#5", "#6", "#7"]);
    expect(links[0]).toEqual({ label: "#9", value: "T<9>", link: "https://f.example/a/b/issues/9" });
    expect(cardFor("map", json, "javascript:x")!.rows[2]!.link).toBeUndefined();
  });

  test("a row's https link draws an anchor that asks the host to open it; any other scheme stays text", () => {
    const s = shell();
    s.send(s.result({
      kind: "map", title: "Plan", status: "", actions: [],
      rows: [
        { label: "#1", value: "ok", link: "https://f.example/a/b/issues/1" },
        { label: "#2", value: "bad", link: "javascript:alert(1)" },
      ],
    }));
    const dts = s.root.all().filter((n) => n.tag === "dt");
    expect(dts.length).toBe(2);
    const a = dts[0]!.children[0]!;
    expect(a.tag).toBe("a");
    expect(a.textContent).toBe("#1");
    expect(a.href).toBe("https://f.example/a/b/issues/1");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.target).toBe("_blank");
    let prevented = false;
    a.onclick!({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(s.posted[0]).toMatchObject({ method: "ui/open-link", params: { url: "https://f.example/a/b/issues/1" } });
    expect(dts[1]!.children.length).toBe(0);
    expect(dts[1]!.textContent).toBe("#2");
    expect(s.root.all().filter((n) => n.tag === "a").length).toBe(1);
  });

  test("a feed row with a forge link is an anchor that asks the host to open it; no link, or a javascript: one, stays text", () => {
    const s = shell();
    const feed = cardFor("feed", { items: [{ what: "x", link: "/a/b/pulls/1" }, { what: "y" }] }, "https://forge.test")!;
    s.send(s.result({ ...feed, rows: [...feed.rows, { label: "z", value: "", link: "javascript:alert(1)" }] }));
    const dts = s.root.all().filter((n) => n.tag === "dt");
    expect(dts).toHaveLength(3);
    const anchor = dts[0]!.children[0]!;
    expect(anchor.tag).toBe("a");
    expect(anchor.href).toBe("https://forge.test/a/b/pulls/1");
    expect(anchor.textContent).toBe("x");
    let prevented = false;
    anchor.onclick!({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
    expect(s.posted[0]).toMatchObject({ method: "ui/open-link", params: { url: "https://forge.test/a/b/pulls/1" } });
    expect(dts[1]!.children).toHaveLength(0);
    expect(dts[2]!.children).toHaveLength(0);
    expect(s.root.all().filter((n) => n.tag === "a")).toHaveLength(1);
  });
});

describe("the Wave card links its limbs", () => {
  const json = { repo: { owner: "a", name: "b" }, limbs: [{ number: 3, name: "x", done: 1, total: 2, building: 0 }, { number: 0, name: "y" }] };
  test("a good origin links a positive number; a bad origin or repo does not", () => {
    const good = cardFor("milestones", json, "https://f.example")!;
    expect(good.rows[0]!.link).toBe("https://f.example/a/b/milestones/3");
    expect(good.rows[1]!.link).toBeUndefined();
    expect(cardFor("milestones", json, "javascript:x")!.rows[0]!.link).toBeUndefined();
    expect(cardFor("milestones", { ...json, repo: {} }, "https://f.example")!.rows[0]!.link).toBeUndefined();
  });
});

describe("app card links", () => {
  const origin = "https://forge.example";
  test("apps rows link to the app page only for an http(s) origin and owner/name", () => {
    const rows = (o: string, app = "alice/game") => cardFor("apps", [{ app, live: "up" }], o)!.rows;
    expect(rows(origin)[0]!.link).toBe("https://forge.example/alice/game");
    expect(rows("javascript:alert(1)")[0]!.link).toBeUndefined();
    expect(rows("//evil.example")[0]!.link).toBeUndefined();
    expect(rows("")[0]!.link).toBeUndefined();
    expect(rows(origin, "a/b/c")[0]!.link).toBeUndefined();
  });
  test("apps adds a linked production row for an http(s) url only", () => {
    const rows = (url: string) => cardFor("apps", [{ app: "alice/game", live: "up", url }], origin)!.rows;
    const good = rows("https://game.example");
    expect(good[1]!.link).toBe("https://game.example");
    const bad = rows("javascript:alert(1)");
    expect(bad).toHaveLength(1);
    expect(bad.every((r) => r.link !== "javascript:alert(1)")).toBe(true);
    const proto = rows("//evil.example");
    expect(proto).toHaveLength(1);
    expect(proto.some((r) => r.link === "//evil.example")).toBe(false);
    expect(proto[0]!.value).toContain("//evil.example");
  });
  test("new_app links Production only when the url is http(s)", () => {
    const prod = (url: string) =>
      cardFor("new_app", { repo: "alice/game", url, run: "none" })!.rows.find((r) => r.label === "Production")!;
    expect(prod("https://game.example").link).toBe("https://game.example");
    expect(prod("javascript:alert(1)").link).toBeUndefined();
    expect(prod("//evil.example").link).toBeUndefined();
  });
});
