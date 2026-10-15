/**
 * The cards: what a tool's answer looks like inside an MCP Apps host
 * (`ui://` resources, SEP-1865). One model per card — a title, a status,
 * rows, and the actions beside them — built from the data the tool
 * already returns. The model is plain data; `CARD_SHELL` is the one
 * sandboxed page every `ui://` resource serves, which draws it with
 * `textContent` and never `innerHTML`.
 */

import { html, raw } from "../html.ts";

export type CardKind = "app" | "run" | "decision" | "wave";

export interface CardRow {
  readonly label: string;
  readonly value: string;
}
export interface CardAction {
  readonly label: string;
  /** The tool the host calls when it is pressed, and with what. */
  readonly tool: string;
  readonly args: Record<string, unknown>;
}
export interface Card {
  readonly kind: CardKind;
  readonly title: string;
  readonly status: string;
  readonly rows: readonly CardRow[];
  readonly actions: readonly CardAction[];
}

export const CARD_MIME = "text/html;profile=mcp-app";
export const CARD_URI = (kind: CardKind): string => `ui://forge/${kind}`;
export const CARD_KINDS: readonly CardKind[] = ["app", "run", "decision", "wave"];

/** The tool whose answer each card draws. */
export const CARD_OF_TOOL: Readonly<Record<string, CardKind>> = {
  apps: "app",
  now: "run",
  asks: "decision",
  milestones: "wave",
};

const CARD_TITLE: Readonly<Record<CardKind, string>> = {
  app: "Apps",
  run: "Working now",
  decision: "Waiting on you",
  wave: "Wave",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const LIMIT = 12;

/** The card for a tool's answer, or nothing when the answer has no card. */
export function cardFor(tool: string, value: unknown): Card | undefined {
  const kind = CARD_OF_TOOL[tool];
  if (kind === undefined) return undefined;
  const rows: CardRow[] = [];
  const actions: CardAction[] = [];
  let status = "";
  if (kind === "app") {
    const apps = list(value).map(obj);
    status = `${apps.length} app${apps.length === 1 ? "" : "s"}`;
    for (const a of apps.slice(0, LIMIT))
      rows.push({
        label: text(a["app"]),
        value: `${text(a["live"])}${a["url"] ? ` · ${text(a["url"])}` : ""}${
          Number(a["working"]) > 0 ? ` · ${text(a["working"])} working` : ""
        }`,
      });
  } else if (kind === "run") {
    const runs = list(value).map(obj);
    status = runs.length === 0 ? "nothing running" : `${runs.length} going`;
    for (const r of runs.slice(0, LIMIT)) {
      const cost = Number(r["costUsd"]) > 0 ? ` · $${Number(r["costUsd"]).toFixed(2)}` : "";
      rows.push({
        label: `${text(r["who"])} on ${text(r["app"])}`,
        value: `${text(r["on"])} — ${text(r["state"])}${cost}`,
      });
      if (r["run"] && actions.length < 3)
        actions.push({ label: `Stop ${text(r["who"])}`, tool: "stop", args: { repo: text(r["app"]), run: text(r["run"]) } });
    }
  } else if (kind === "decision") {
    const asks = list(obj(value)["rows"]).map(obj);
    status = asks.length === 0 ? "nothing waits" : `${asks.length} waiting`;
    for (const a of asks.slice(0, LIMIT)) {
      const words = obj(a["words"]);
      rows.push({
        label: text(a["line"]),
        value: `${text(words["decision"])} ${list(words["options"]).map(text).join(" / ")}`.trim(),
      });
    }
    const first = asks[0];
    if (first !== undefined) {
      const items = list(first["items"]).map(text);
      const kindOf = text(first["kind"]);
      // No `dryRun`: the press is the dry run `asks_act` defaults to, and the
      // host shows what would change before anything ships or closes. Tell and
      // Redirect are absent: the card has no field for the person's words.
      if (kindOf === "look" || kindOf === "review")
        actions.push({ label: "Approve", tool: "asks_act", args: { action: "ship", items } });
      actions.push({ label: "Decline", tool: "asks_act", args: { action: "close", items } });
    }
  } else {
    const limbs = list(obj(value)["limbs"]).map(obj);
    const repo = obj(obj(value)["repo"]);
    status = `${text(repo["owner"])}/${text(repo["name"])}`.replace(/^\/$/, "");
    for (const l of limbs.slice(0, LIMIT))
      rows.push({
        label: `#${text(l["number"])} ${text(l["name"])}`,
        value: `${text(l["done"])}/${text(l["total"])} done · ${text(l["building"])} building`,
      });
  }
  return { kind, title: CARD_TITLE[kind], status, rows, actions };
}

/**
 * The page behind every `ui://forge/*` resource. The host posts the tool's
 * result to it (`ui/notifications/tool-result`); it reads `card` from the
 * structured content and draws it with `textContent`. A button asks the
 * host to call the tool; the host decides whether to.
 */
const SHELL_JS = `
const root = document.getElementById("card");
const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
let n = 0;
function draw(card) {
  root.replaceChildren(el("h2", card.title), el("p", card.status, "status"));
  const dl = document.createElement("dl");
  for (const r of card.rows) dl.append(el("dt", r.label), el("dd", r.value));
  root.append(dl);
  for (const a of card.actions) {
    const b = el("button", a.label);
    b.onclick = () => parent.postMessage({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: a.tool, arguments: a.args } }, "*");
    root.append(b);
  }
}
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m && m.method === "ui/notifications/tool-result") {
    const card = m.params && m.params.structuredContent && m.params.structuredContent.card;
    if (card) draw(card);
  }
});
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
`;

export const CARD_SHELL = (kind: CardKind): string =>
  html`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${CARD_TITLE[kind]}</title><style>body{font:14px system-ui;margin:0;padding:12px}h2{margin:0 0 4px;font-size:16px}.status{margin:0 0 8px;opacity:.7}dt{font-weight:600;margin-top:6px}dd{margin:0}button{margin:8px 6px 0 0;padding:4px 10px}</style><div id="card"><h2>${CARD_TITLE[kind]}</h2></div><script>${raw(SHELL_JS)}</script>`.text;
