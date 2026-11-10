/**
 * The cards: what a tool's answer looks like inside an MCP Apps host
 * (`ui://` resources, SEP-1865). One model per card — a title, a status,
 * rows, and the actions beside them — built from the data the tool
 * already returns. The model is plain data; `CARD_SHELL` is the one
 * sandboxed page every `ui://` resource serves, which draws it with
 * `textContent` and never `innerHTML`.
 */

import { html, raw } from "../html.ts";
import { timeAgo } from "../ui.ts";
import { span, STAGE_LABEL, verdict, type PipelineKey, type PipelineStage } from "../../flow/pipeline.ts";

export type CardKind = "app" | "run" | "asks" | "wave" | "map" | "feed" | "pull" | "pulls" | "asked" | "explore" | "issue" | "flow" | "scorecard" | "crew" | "board" | "forks" | "milestones" | "release";

export interface CardRow {
  readonly label: string;
  readonly value: string;
  /** An absolute http(s) address the row's label links to. */
  readonly link?: string;
  /** How many steps the row is nested (a tree): the card pads the label by this much. */
  readonly depth?: number;
  /** The row's own buttons: what the person can do with this one row. */
  readonly actions?: readonly CardAction[];
}
export interface CardAction {
  readonly label: string;
  /** The tool the host calls when it is pressed, and with what. */
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Set when the press sends the person's typed words as `text` (and into `context.said`, if the args carry a `context`). */
  readonly words?: true;
}
export interface Card {
  readonly kind: CardKind;
  readonly title: string;
  readonly status: string;
  readonly rows: readonly CardRow[];
  readonly actions: readonly CardAction[];
}

/** Only a rooted path on this forge: "//host" or another forge's address would leave it. */
const here = (origin: string, path: string): boolean => origin !== "" && /^\/(?!\/)/.test(path);

export const CARD_MIME = "text/html;profile=mcp-app";
export const CARD_URI = (kind: CardKind): string => `ui://forge/${kind}`;
export const CARD_KINDS: readonly CardKind[] = ["app", "run", "asks", "wave", "map", "feed", "pull", "pulls", "asked", "explore", "issue", "flow", "scorecard", "crew", "board", "forks", "milestones", "release"];

/** The tool whose answer each card draws. */
export const CARD_OF_TOOL: Readonly<Record<string, CardKind>> = {
  apps: "app",
  now: "crew",
  runs: "run",
  asks: "asks",
  milestones: "milestones",
  releases: "release",
  asks_act: "asks",
  waves: "wave",
  map: "map",
  feed: "feed",
  explore: "explore",
  new_app: "app",
  pull: "pull",
  pulls: "pulls",
  asked: "asked",
  issue: "issue",
  flow: "flow",
  scorecard: "scorecard",
  boards: "board",
  fork_tree: "forks",
};

const CARD_TITLE: Readonly<Record<CardKind, string>> = {
  app: "Apps",
  run: "Working now",
  asks: "Waiting on you",
  wave: "Wave",
  map: "Plan",
  feed: "Feed",
  explore: "Explore",
  pull: "Pull",
  pulls: "Pulls",
  asked: "Asked",
  issue: "Issue",
  flow: "Flow",
  scorecard: "Crew",
  crew: "Working now",
  board: "Board",
  forks: "Forks",
  milestones: "Milestones",
  release: "Releases",
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const LIMIT = 12;
const FEED_LIMIT = 10;
const PULLS_LIMIT = 20;
const ASKED_WORDS = 80;
const ASKED_LIMIT = 20;
const RELEASE_ROWS = 20;
/** A waiting row's words are cut to this many characters. */
const SAYS_WORDS = 160;
/** A board card shows this many panels, then counts the rest. */
const BOARD_PANELS = 8;
/** A forks card shows this many nodes, then counts the rest. */
const FORK_ROWS = 30;
/** How a fork follows its parent, in plain words. */
const FOLLOW_WORDS: Readonly<Record<string, string>> = {
  autonomous: "follows on its own",
  "take-updates": "takes updates",
  offers: "offers updates",
  "dont-follow": "off",
};
/** The forge's id shape (src/kernel/id.ts): 26 lowercase Crockford base32 characters. */
const RUN_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

/** A run state as one check word: what a pull's check says at a glance. */
const checkWord = (state: string): string =>
  state === "ok" ? "green"
  : state === "failed" ? "red"
  : state === "queued" || state === "running" ? "running"
  : state === "cancelled" ? "cancelled"
  : "none";

/** An absolute http(s) address: the only origin a card builds links on. */
const web = (u: string): boolean => /^https?:\/\//.test(u);
/** A repository named `owner/name`. */
const slugOf = (s: string): boolean => /^[^/]+\/[^/]+$/.test(s);

/** " · smith, juniper": who has a run going on the app, or nothing. */
const crewWords = (crew: unknown): string => {
  const names = list(crew).map(text).filter((n) => n !== "").slice(0, 3);
  return names.length === 0 ? "" : ` · ${names.join(", ")}`;
};
/** " · pull #7 https://…": the app's running previews, in its one line; only http(s) addresses. */
const previewWords = (previews: unknown): string =>
  list(previews).map(obj).filter((p) => web(text(p["url"]))).slice(0, 3)
    .map((p) => ` · pull #${text(p["pull"])} ${text(p["url"])}`).join("");

/** The card for a tool's answer, or nothing when the answer has no card. */
export function cardFor(
  tool: string,
  value: unknown,
  origin = "",
  extra: Record<string, unknown> = {},
): Card | undefined {
  const kind = CARD_OF_TOOL[tool];
  if (kind === undefined) return undefined;
  const rows: CardRow[] = [];
  const actions: CardAction[] = [];
  let status = "";
  if (tool === "waves") {
    // Only one wave is a card; the list is text.
    const w = obj(obj(value)["wave"]);
    if (text(w["version"]) === "") return undefined;
    const repo = text(obj(value)["repo"]);
    const pulls = list(w["pulls"]).map(text);
    rows.push({ label: "Headline", value: text(w["headline"]) });
    for (const h of list(w["highlights"]).map(obj).slice(0, LIMIT))
      rows.push({ label: text(h["title"]), value: text(h["why"]) });
    if (pulls.length > 0)
      rows.push({ label: "Pulls", value: pulls.slice(0, LIMIT).map((n) => `#${n}`).join(" ") });
    return { kind, title: `Wave ${text(w["version"])}`, status: `${repo} · ${text(w["date"])}`.replace(/^ · /, ""), rows, actions };
  }
  if (kind === "flow") {
    // Only the no-argument answer has `stages`; a fleet query or a `why` answer stays plain JSON.
    const stages = list(obj(value)["stages"]).map(obj).filter((s) => text(s["key"]) in STAGE_LABEL);
    if (stages.length === 0) return undefined;
    const now = Date.now();
    const typed = stages.map((s): PipelineStage => ({
      key: text(s["key"]) as PipelineKey,
      waiting: Number(s["waiting"]) || 0,
      active: Number(s["active"]) || 0,
      oldestWaiting: typeof s["oldestWaiting"] === "string" ? s["oldestWaiting"] : null,
      capacity: typeof s["capacity"] === "string" ? s["capacity"] : null,
    }));
    for (const s of typed) {
      const wait = s.oldestWaiting === null || Number.isNaN(Date.parse(s.oldestWaiting)) ? "" : ` · oldest ${span(now - Date.parse(s.oldestWaiting))}`;
      rows.push({ label: STAGE_LABEL[s.key], value: `${s.waiting} waiting · ${s.active} active${wait}` });
    }
    return { kind, title: CARD_TITLE[kind], status: verdict(typed, now), rows, actions };
  }
  if (kind === "board") {
    // One board's answer is `{ slug, title, range, refresh, panels: [{ title, … }] }`; the list and a
    // panel's data have no `panels`, so no card. `extra.values` are the panels' current values, in order.
    const v = obj(value);
    if (!Array.isArray(v["panels"]) || text(v["title"]) === "") return undefined;
    const panels = v["panels"].map(obj);
    const values = list(extra["values"]).map(text);
    for (const [i, p] of panels.slice(0, BOARD_PANELS).entries())
      rows.push({ label: text(p["title"]), value: values[i] ?? "no data" });
    if (panels.length > BOARD_PANELS) rows.push({ label: "More", value: `${panels.length - BOARD_PANELS} more` });
    return { kind, title: text(v["title"]), status: `${panels.length} panel${panels.length === 1 ? "" : "s"} · ${text(v["range"])}`, rows, actions };
  }
  if (kind === "forks") {
    // `fork_tree` answers `{ root, nodes: [{ repo, parent, depth, follow }], truncated }`; a repo with no readable tree has no card.
    const v = obj(value);
    if (text(v["root"]) === "" || !Array.isArray(v["nodes"])) return undefined;
    const nodes = v["nodes"].map(obj);
    for (const n of nodes.slice(0, FORK_ROWS)) {
      const repo = text(n["repo"]);
      const depth = Math.min(8, Math.max(0, Math.floor(Number(n["depth"]) || 0)));
      rows.push({
        label: repo,
        ...(depth > 0 ? { depth } : {}),
        value: FOLLOW_WORDS[text(n["follow"])] ?? "off",
        ...(web(origin) && slugOf(repo) ? { link: `${origin}/${repo}` } : {}),
      });
    }
    const left = nodes.length - FORK_ROWS;
    if (left > 0) rows.push({ label: "More", value: `${left} more not shown` });
    if (v["truncated"] === true) rows.push({ label: "Truncated", value: "more forks exist than the tool returned; ask with a larger limit or a smaller depth" });
    return { kind, title: CARD_TITLE[kind], status: `${nodes.length} repositor${nodes.length === 1 ? "y" : "ies"} · from ${text(v["root"])}`, rows, actions };
  }
  if (tool === "asks_act") {
    // Only a done bulk action has a card: its receipt, and the undo that takes it back.
    // A plan (`dryRun`) or a `listen` has no `receipt`.
    const v = obj(value);
    const operation = text(v["id"]);
    if (text(v["receipt"]) === "" || operation === "") return undefined;
    rows.push({ label: "Receipt", value: text(v["receipt"]) });
    if (v["undoOf"] == null && v["undoneBy"] == null)
      actions.push({ label: "Undo", tool: "asks_act", args: { action: "undo", operation } });
    return { kind, title: "Asks decided", status: text(v["receipt"]), rows, actions };
  }
  if (kind === "crew") {
    // `now` answers crewNow's rows; a waiting row has `run: null` and its words in `says`.
    const crew = list(value).map(obj);
    status = crew.length === 0 ? "nothing running" : `${crew.length} going`;
    for (const r of crew.slice(0, LIMIT)) {
      const cost = Number(r["costUsd"]) > 0 ? ` · $${Number(r["costUsd"]).toFixed(2)}` : "";
      const since = text(r["since"]) === "" ? "" : ` · ${timeAgo(text(r["since"]))}`;
      const says = r["run"] === null ? text(r["says"]).replace(/\s+/g, " ").trim() : "";
      const words = says === "" ? "" : ` — ${says.length > SAYS_WORDS ? `${says.slice(0, SAYS_WORDS - 1)}…` : says}`;
      rows.push({
        label: `${text(r["who"])} on ${text(r["app"])}`,
        value: `${text(r["on"]) === "" ? "" : `${text(r["on"])} — `}${text(r["state"])}${since}${cost}${words}`,
        ...(web(origin) && slugOf(text(r["app"])) && RUN_ID.test(text(r["run"]))
          ? { link: `${origin}/${text(r["app"])}/runs/${text(r["run"])}` }
          : {}),
      });
      if (r["run"] && actions.length < 3)
        actions.push({ label: `Stop ${text(r["who"])}`, tool: "stop", args: { repo: text(r["app"]), run: text(r["run"]) } });
    }
    // The card shows LIMIT rows; the rest are counted, never dropped silently.
    if (crew.length > LIMIT) rows.push({ label: "More", value: `+${crew.length - LIMIT} more` });
    return { kind, title: CARD_TITLE[kind], status, rows, actions };
  }
  if (kind === "scorecard") {
    // `scorecard` answers `{ agents: [{ username, all, recent }], keeperDays: [{ landed }] }`.
    const v = obj(value);
    if (!Array.isArray(v["agents"])) return undefined;
    const agents = v["agents"].map(obj);
    const week = list(v["keeperDays"]).reduce<number>((n, d) => n + (Number(obj(d)["landed"]) || 0), 0);
    const crewStatus = `${week} landed this week`;
    for (const a of agents.slice(0, LIMIT)) {
      const w = obj(a["week"]);
      const wk = `${Number(w["merged"]) || 0} merged · ${Number(w["returned"]) || 0} returned · $${(Number(w["cost"]) || 0).toFixed(2)} this week`;
      rows.push({ label: text(a["username"]), value: wk });
    }
    // The card shows LIMIT agents; the rest are counted, never dropped silently.
    if (agents.length > LIMIT) rows.push({ label: "More", value: `+${agents.length - LIMIT} more` });
    return { kind, title: CARD_TITLE[kind], status: crewStatus, rows, actions };
  }
  if (tool === "new_app") {
    const made = obj(value);
    const repo = text(made["repo"]);
    const run = text(made["run"]);
    status = run === "none" || run === "" ? "alive" : `alive · first run ${run}`;
    rows.push({ label: "App", value: repo });
    if (made["url"]) {
      const url = text(made["url"]);
      rows.push({
        label: "Production",
        value: url,
        ...(web(url) ? { link: url } : {}),
      });
    }
    if (made["issue"]) rows.push({ label: "First issue", value: `#${text(made["issue"])}` });
    if (made["agent"]) rows.push({ label: "Agent", value: text(made["agent"]) });
    rows.push({ label: "First run", value: run === "" ? "none" : run });
    if (repo !== "")
      actions.push({ label: `Tell ${repo}`, tool: "tell", args: { repo, context: {} }, words: true });
    return { kind, title: "New app", status, rows, actions };
  }
  if (kind === "pull") {
    const p = obj(value);
    const state = text(p["state"]);
    const check = text(obj(p["check"])["state"]);
    const word = checkWord(check);
    const conflicts = list(p["conflicts"]).map(text).filter((c) => c !== "");
    status = [
      state,
      state === "open" && word !== "none" ? `check ${word}` : "",
      state === "open" && conflicts.length > 0 ? "conflicts" : "",
    ]
      .filter((w) => w !== "")
      .join(" · ");
    const number = text(p["number"]);
    const slug = text(extra["repo"]);
    rows.push({
      label: "Branches",
      value: `${text(p["head"])} → ${text(p["base"])}`,
      ...(web(origin) && slugOf(slug) && number !== ""
        ? { link: `${origin}/${slug}/pulls/${number}` }
        : {}),
    });
    if (conflicts.length > 0)
      rows.push({ label: "Conflicts", value: conflicts.slice(0, LIMIT).join(", ") });
    const preview = text(extra["preview"]);
    if (web(preview)) rows.push({ label: "Preview", value: preview, link: preview });
    return { kind, title: `#${number} ${text(p["title"])}`.trim(), status, rows, actions };
  }
  if (kind === "pulls") {
    // `pulls` answers `{ pulls: [{ number, title, check, … }] }`; the repo and
    // the state asked for come in `extra`.
    const pulls = list(obj(value)["pulls"]).map(obj);
    // The tool stops at `limit`: a full answer may be the first of more.
    const cut = typeof extra["limit"] === "number" && pulls.length >= extra["limit"];
    status = `${pulls.length}${cut ? "+" : ""} ${extra["state"] === "closed" ? "closed" : "open"}`;
    const slug = text(extra["repo"]);
    for (const p of pulls.slice(0, PULLS_LIMIT)) {
      const number = text(p["number"]);
      const check = text(p["check"]);
      const path = `/${slug}/pulls/${number}`;
      rows.push({
        label: `#${number} ${text(p["title"])}`.trim(),
        value: checkWord(check),
        ...(web(origin) && slugOf(slug) && /^[1-9]\d*$/.test(number) && here(origin, path)
          ? { link: origin + path }
          : {}),
      });
    }
    return { kind, title: CARD_TITLE[kind], status, rows, actions };
  }
  if (kind === "release") {
    // `releases` answers `{ items: [{ sha, version, pull?, landed, proof, live? }] }`; the shipped list has no `items`, so no card.
    const items = list(obj(value)["items"]).map(obj);
    if (!Array.isArray(obj(value)["items"])) return undefined;
    const count = (w: string): number => items.filter((i) => i["proof"] === w).length;
    status = `${items.length} kept · ${count("proven")} proven · ${count("unproven")} unproven · ${count("rolled back")} rolled back`;
    for (const i of items.slice(0, RELEASE_ROWS)) {
      const p = obj(i["pull"]);
      const pull = text(p["number"]) === "" ? "" : `#${text(p["number"])} · `;
      const at = text(i["landed"]);
      rows.push({
        label: text(i["version"]) || text(i["sha"]),
        value: `${at === "" ? "" : `${timeAgo(at)} · `}${pull}${text(i["proof"])}`,
      });
    }
    return { kind, title: CARD_TITLE[kind], status, rows, actions };
  }
  if (kind === "asked") {
    // `asked` answers `{ asked: [{ repo, number, title, state, flagged, pulls }] }`.
    const asks = list(obj(value)["asked"]).map(obj);
    const flagged = asks.filter((a) => a["flagged"] === true);
    const waiting = asks.filter((a) => a["state"] === "waiting").length;
    status = `${waiting} waiting · ${flagged.length} flagged`;
    for (const a of [...flagged, ...asks.filter((a) => a["flagged"] !== true)].slice(0, ASKED_LIMIT)) {
      const repo = text(a["repo"]);
      const number = text(a["number"]);
      // The pull that closes it: a landed one, else an open one, else the issue.
      const pulls = list(a["pulls"]).map(obj);
      const closing = pulls.find((p) => p["state"] === "merged") ?? pulls.find((p) => p["state"] === "open");
      const pullNumber = closing === undefined ? "" : text(closing["number"]);
      const path =
        /^[1-9]\d*$/.test(pullNumber) ? `/${repo}/pulls/${pullNumber}` : `/${repo}/issues/${number}`;
      const title = text(a["title"]);
      rows.push({
        label: title.length > ASKED_WORDS ? `${title.slice(0, ASKED_WORDS - 1)}…` : title,
        value: text(a["state"]),
        ...(web(origin) && slugOf(repo) && /^[1-9]\d*$/.test(number) && here(origin, path)
          ? { link: origin + path }
          : {}),
      });
    }
    return { kind, title: CARD_TITLE[kind], status, rows, actions };
  }
  if (kind === "issue") {
    const v = obj(value);
    const number = text(v["number"]);
    // A number that names a pull answers `{kind:"pull"}`: no issue, no card.
    if (v["kind"] === "pull" || !/^[1-9]\d*$/.test(number)) return undefined;
    const slug = text(extra["repo"]);
    const base = web(origin) && /^[^/\s]+\/[^/\s]+$/.test(slug) ? `${origin}/${slug}/issues/` : "";
    const at = (n: string): { link?: string } => (base !== "" && /^\d+$/.test(n) ? { link: base + n } : {});
    status = text(v["state"]) + (v["closeReason"] ? ` · ${text(v["closeReason"])}` : "");
    rows.push({ label: `#${number}`, value: text(v["title"]), ...at(number) });
    // The title is an outsider's when the answer says so; the card says so too.
    if (v["untrusted"] === true) rows.push({ label: "Author", value: "untrusted: not a writer on this repository" });
    rows.push({ label: "Assignee", value: text(v["assignee"]) || "nobody" });
    const labels = list(v["labels"]).map(text).filter((l) => l !== "");
    if (labels.length > 0) rows.push({ label: "Labels", value: labels.join(", ") });
    for (const b of list(v["blockedBy"]).map(obj).slice(0, LIMIT))
      rows.push({ label: "Waits for", value: `#${text(b["number"])} · ${text(b["state"])}`, ...at(text(b["number"])) });
    return { kind, title: `Issue #${number}`, status, rows, actions };
  }
  if (kind === "app") {
    const apps = list(value).map(obj);
    status = `${apps.length} app${apps.length === 1 ? "" : "s"}`;
    for (const a of apps.slice(0, LIMIT)) {
      const url = text(a["url"]);
      rows.push({
        label: text(a["app"]),
        value: `${text(a["live"])}${url && !web(url) ? ` · ${url}` : ""}${
          Number(a["working"]) > 0 ? ` · ${text(a["working"])} working` : ""
        }${crewWords(a["crew"])}${previewWords(a["previews"])}`,
        ...(web(origin) && /^[^/]+\/[^/]+$/.test(text(a["app"]))
          ? { link: `${origin}/${text(a["app"])}` }
          : {}),
      });
      if (web(url)) rows.push({ label: `${text(a["app"])} production`, value: url, link: url });
    }
    for (const a of apps.slice(0, 3))
      if (text(a["app"]) !== "")
        actions.push({ label: `Tell ${text(a["app"])}`, tool: "tell", args: { repo: text(a["app"]), context: {} }, words: true });
  } else if (tool === "runs") {
    // `runs` answers `{ runs: [{ id, kind, state, number, startedAt, endedAt }] }`,
    // newest first; the repo comes in `extra`; past runs, so the card offers no stop.
    const runs = list(obj(value)["runs"]).map(obj);
    status = runs.length === 0 ? "no runs" : `${runs.length} run${runs.length === 1 ? "" : "s"}`;
    const slug = text(extra["repo"]);
    for (const r of runs.slice(0, LIMIT))
      rows.push({
        label: `${text(r["kind"])} ${text(r["id"])}`,
        value: `${r["number"] == null ? "" : `#${text(r["number"])} — `}${text(r["state"])}`,
        ...(web(origin) && slugOf(slug) && RUN_ID.test(text(r["id"]))
          ? { link: `${origin}/${slug}/runs/${text(r["id"])}` }
          : {}),
      });
    return { kind, title: "Runs", status, rows, actions };
  } else if (kind === "run") {
    const runs = list(value).map(obj);
    status = runs.length === 0 ? "nothing running" : `${runs.length} going`;
    for (const r of runs.slice(0, LIMIT)) {
      const cost = Number(r["costUsd"]) > 0 ? ` · $${Number(r["costUsd"]).toFixed(2)}` : "";
      const since = text(r["since"]) === "" ? "" : ` · ${timeAgo(text(r["since"]))}`;
      rows.push({
        label: `${text(r["who"])} on ${text(r["app"])}`,
        value: `${text(r["on"]) === "" ? "" : `${text(r["on"])} — `}${text(r["state"])}${since}${cost}`,
        ...(web(origin) && /^[^/]+\/[^/]+$/.test(text(r["app"])) && RUN_ID.test(text(r["run"]))
          ? { link: `${origin}/${text(r["app"])}/runs/${text(r["run"])}` }
          : {}),
      });
      if (r["run"] && actions.length < 3)
        actions.push({ label: `Stop ${text(r["who"])}`, tool: "stop", args: { repo: text(r["app"]), run: text(r["run"]) } });
    }
  } else if (kind === "asks") {
    const asks = list(obj(value)["rows"]).map(obj);
    status = asks.length === 0 ? "Nothing waits on you." : `${asks.length} waiting`;
    for (const a of asks.slice(0, LIMIT)) {
      const words = obj(a["words"]);
      const repo = text(a["repo"]);
      const number = Number(a["number"]);
      const page = a["numberOf"] === "pull" ? "pulls" : a["numberOf"] === "issue" ? "issues" : "";
      const at = text(a["link"]);
      const waited = text(a["since"]) === "" ? "" : `waiting ${timeAgo(text(a["since"]))}`.replace(" ago", "");
      const what = `${text(words["decision"])} ${list(words["options"]).map(text).join(" / ")}`.trim();
      const items = list(a["items"]).map(text);
      const kindOf = text(a["kind"]);
      // No `dryRun`: the press is the dry run `asks_act` defaults to, and the
      // host shows what would change before anything ships or closes. The
      // tools check the same permission the page's buttons do.
      const one: CardAction | undefined =
        items.length === 0 || kindOf === "proposal" || kindOf === "paused" ? undefined
        : kindOf === "look" || kindOf === "review" ? { label: "Ship", tool: "asks_act", args: { action: "ship", items } }
        : kindOf === "parked" ? (items.length === 1 ? { label: "Decide", tool: "asks_decide", args: { item: items[0] } } : undefined)
        : { label: "Decline", tool: "asks_act", args: { action: "close", items } };
      rows.push({
        label: text(a["line"]),
        value: [waited, what].filter((x) => x !== "").join(" · "),
        ...(web(origin) && slugOf(repo) && Number.isInteger(number) && number > 0 && page !== ""
          ? { link: `${origin}/${repo}/${page}/${number}` }
          : web(origin) && here(origin, at) ? { link: origin + at } : {}),
        ...(one === undefined ? {} : { actions: [one] }),
      });
    }
  } else if (kind === "map") {
    const v = obj(value);
    const issues = list(v["issues"]).map(obj);
    const pillars = list(v["pillars"]).map(obj);
    // The plan's umbrellas are furniture, not work: `pillarRows` skips them, so does this.
    const furniture = new Set(pillars.map((p) => text(p["umbrella"])));
    const work = issues.filter((i) => i["state"] === "open" && !furniture.has(text(i["number"])));
    const count = (word: string): number => work.filter((i) => i["word"] === word).length;
    status = `${count("ready")} ready · ${count("working")} working · ${count("blocked")} waiting`;
    for (const p of pillars.slice(0, LIMIT)) {
      const name = p["pillar"] === null ? "" : text(p["pillar"]);
      const working = work.filter((i) => i["word"] === "working" && (i["pillar"] ?? null) === (p["pillar"] ?? null)).length;
      rows.push({
        label: name === "" ? "No pillar" : name,
        value: `${text(p["ready"])} ready · ${working} working · ${text(p["blocked"])} waiting`,
      });
    }
    const repo = obj(v["repo"]);
    const base = `${origin}/${text(repo["owner"])}/${text(repo["name"])}/issues/`;
    for (const r of list(v["ready"]).map(obj).filter((r) => r["word"] === "ready").slice(0, 5)) {
      const number = text(r["number"]);
      rows.push({
        label: `#${number}`,
        value: text(r["title"]),
        ...(web(origin) && number !== "" ? { link: base + number } : {}),
      });
    }
  } else if (kind === "feed") {
    const fresh = Number(obj(value)["new"]);
    status = Number.isInteger(fresh) && fresh > 0 ? `${fresh} new since you last looked` : "Latest";
    for (const i of list(obj(value)["items"]).map(obj).slice(0, FEED_LIMIT)) {
      const link = text(i["link"]);
      const who = text(i["actor"]);
      rows.push({
        label: `${who === "" ? "" : `${who}: `}${text(i["what"])}`,
        value: [text(i["app"]), timeAgo(text(i["at"]))].filter((x) => x !== "").join(" · "),
        ...(here(origin, link) ? { link: origin + link } : {}),
      });
    }
  } else if (kind === "explore") {
    const items = list(obj(value)["items"]).map(obj);
    const query = text(obj(value)["query"]);
    status = `${items.length} ranked${query === "" ? "" : ` · ${query}`}`;
    for (const i of items.slice(0, FEED_LIMIT)) {
      const n = obj(i["numbers"]);
      const link = text(i["url"]);
      const kindOf = text(i["kind"]);
      rows.push({
        label: `${kindOf} · ${text(i["name"])}`,
        value:
          kindOf === "forge"
            ? text(i["description"])
            : `${text(n["forks"])} forks · ${text(n["ships"])} ships · ${text(n["awakeHours"])} h awake${
                kindOf === "person" ? ` · ${text(n["apps"])} apps` : ""
              }`,
        ...(here(origin, link) ? { link: origin + link } : {}),
      });
      const repo = obj(i["repo"]);
      const slug = `${text(repo["owner"])}/${text(repo["name"])}`;
      if (kindOf === "app" && i["copyable"] === true && origin !== "" && /^[^/]+\/[^/]+$/.test(slug))
        rows.push({
          label: "Make it yours",
          value: text(i["name"]),
          link: `${origin}/${slug}/make-it-yours`,
        });
    }
  } else {
    // One milestone opened (`issue`) answers without `limbs`: plain JSON.
    if (!Array.isArray(obj(value)["limbs"]) || "buildingNow" in obj(value)) return undefined;
    const limbs = list(obj(value)["limbs"]).map(obj);
    const repo = obj(obj(value)["repo"]);
    const slug = `${text(repo["owner"])}/${text(repo["name"])}`;
    status = slug.replace(/^\/$/, "");
    const linkable = web(origin) && /^[^/]+\/[^/]+$/.test(slug);
    for (const l of limbs.slice(0, LIMIT)) {
      const number = Number(l["number"]);
      rows.push({
        label: `#${text(l["number"])} ${text(l["name"])}`,
        value: `${text(l["done"])}/${text(l["total"])} done · ${text(l["building"])} building`,
        ...(linkable && Number.isInteger(number) && number > 0 ? { link: `${origin}/${slug}/milestones/${number}` } : {}),
      });
    }
  }
  return { kind, title: CARD_TITLE[kind], status, rows, actions };
}

/**
 * The page behind every `ui://forge/*` resource. The host posts the tool's
 * result to it (`ui/notifications/tool-result`); it reads `card` from the
 * structured content and draws it with `textContent`. A button asks the
 * host to call the tool; the host decides whether to.
 */
export const SHELL_JS = `
const root = document.getElementById("card");
const el = (tag, text, cls) => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
let n = 0;
let field = null;
function button(a) {
  const b = el("button", a.label);
  b.onclick = () => {
    let args = a.args;
    if (a.words) {
      const said = field.value.trim();
      if (said === "") { field.focus(); return; }
      args = { ...a.args, text: said };
      if (a.args.context && typeof a.args.context === "object") args.context = { ...a.args.context, said };
    }
    parent.postMessage({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: a.tool, arguments: args } }, "*");
  };
  return b;
}
function draw(card) {
  root.replaceChildren(el("h2", card.title), el("p", card.status, "status"));
  const dl = document.createElement("dl");
  for (const r of card.rows) {
    const dt = el("dt", r.label);
    if (r.depth > 0) dt.style.paddingInlineStart = Math.min(8, r.depth) * 1.25 + "em";
    if (r.link && (r.link.startsWith("https://") || r.link.startsWith("http://"))) { const a = el("a", r.label); a.href = r.link; a.target = "_blank"; a.rel = "noopener noreferrer"; a.onclick = (ev) => { ev.preventDefault(); parent.postMessage({ jsonrpc: "2.0", id: ++n, method: "ui/open-link", params: { url: r.link } }, "*"); }; dt.replaceChildren(a); }
    const dd = el("dd", r.value);
    for (const a of r.actions || []) dd.append(button(a));
    dl.append(dt, dd);
  }
  root.append(dl);
  field = card.actions.some((a) => a.words) ? document.createElement("input") : null;
  if (field) { field.type = "text"; field.maxLength = 2000; field.placeholder = "Your words"; field.setAttribute("aria-label", "Your words"); root.append(field); }
  for (const a of card.actions) root.append(button(a));
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
