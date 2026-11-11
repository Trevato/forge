import { describe, expect, test } from "bun:test";
import { SHELL_JS, cardFor } from "../src/web/studio/cards.ts";
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

function shell() {
  const root = new Node("div");
  const posted: any[] = [];
  const parent = { postMessage: (m: unknown) => posted.push(m) };
  let listener: (e: any) => void = () => {};
  const document = { getElementById: () => root, createElement: (t: string) => new Node(t) };
  new Function("document", "parent", "addEventListener", SHELL_JS)(
    document, parent, (_: string, f: (e: any) => void) => (listener = f),
  );
  const send = (data: unknown, source: unknown = parent) => listener({ source, data });
  const result = (card: unknown) =>
    ({ method: "ui/notifications/tool-result", params: { structuredContent: { card } } });
  return { root, posted, parent, send, result };
}

describe("the card shell", () => {
  test("announces itself, draws with textContent, ignores other sources, posts tools/call", () => {
    const s = shell();
    expect(s.posted[0].method).toBe("ui/notifications/initialized");
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
    expect(s.posted[1]).toMatchObject({
      method: "tools/call",
      params: { name: "stop", arguments: { repo: "a/b", run: "r1" } },
    });
  });

  test("Tell sends the typed words, and nothing when empty", () => {
    const s = shell();
    const app = cardFor("apps", [{ app: "alice/game", live: "up" }])!;
    s.send(s.result(app));
    const input = s.root.all().find((n) => n.tag === "input")!;
    const tell = s.root.all().find((n) => n.tag === "button")!;
    tell.onclick!();
    expect(s.posted.length).toBe(1);
    expect(input.focused).toBe(true);
    input.value = " make it blue ";
    tell.onclick!();
    expect(s.posted[1].params).toEqual({
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
    expect(s.posted[1]).toMatchObject({ method: "ui/open-link", params: { url: "https://f.example/a/b/issues/1" } });
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
    expect(s.posted[1]).toMatchObject({ method: "ui/open-link", params: { url: "https://forge.test/a/b/pulls/1" } });
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
