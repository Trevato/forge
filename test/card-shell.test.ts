import { describe, expect, test } from "bun:test";
import { SHELL_JS, cardFor } from "../src/web/studio/cards.ts";

class Node {
  children: Node[] = [];
  textContent = "";
  className = "";
  value = "";
  href = "";
  onclick: ((ev?: any) => void) | undefined;
  focused = false;
  constructor(readonly tag: string) {}
  append(...n: Node[]) { this.children.push(...n); }
  replaceChildren(...n: Node[]) { this.children = n; }
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

  test("Tell and Redirect send the typed words, and nothing when empty", () => {
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
    const ask = cardFor("asks", {
      rows: [{ line: "a", kind: "look", items: ["x:1"], repo: "alice/game", number: 4, words: {} }],
    })!;
    s.send(s.result(ask));
    const redirect = s.root.all().find((n) => n.tag === "button" && n.textContent === "Redirect")!;
    s.root.all().find((n) => n.tag === "input")!.value = "not like that";
    redirect.onclick!();
    expect(s.posted[2].params).toEqual({
      name: "say",
      arguments: { repo: "alice/game", number: 4, text: "not like that" },
    });
  });

  test("an ask without a number offers no Redirect", () => {
    const card = cardFor("asks", { rows: [{ line: "a", kind: "paused", items: ["x"], repo: "a/b", words: {} }] })!;
    expect(card.actions.some((a) => a.tool === "say")).toBe(false);
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
