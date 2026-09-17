/**
 * The big view's pure half: where a movement lands, what a typed command
 * means, and the key sheet every view is drawn from. No DOM in here, so
 * the page renders the footer and the sheet from the same table the client
 * acts on, and a test can hold them against each other. The client script
 * (`big.ts`) carries these functions by their source (`String(fn)`), so
 * the browser runs exactly what the tests ran.
 */

export type View = "home" | "app" | "run" | "board" | "map" | "list";

export type ListKind = "runs" | "issues" | "pulls" | "map";

// ---- where things are ----

/** The one shape of a big-view address: what is open, and how deep. */
export interface Where {
  readonly app?: string | undefined;
  readonly list?: ListKind | undefined;
  readonly run?: string | undefined;
  readonly view?: "board" | "map" | undefined;
}

export function bigUrl(where: Where): string {
  const q = new URLSearchParams();
  if (where.run !== undefined) q.set("run", where.run);
  else if (where.app !== undefined) {
    q.set("app", where.app);
    if (where.list !== undefined) q.set("list", where.list);
  } else if (where.view !== undefined) q.set("view", where.view);
  const text = q.toString();
  return text === "" ? "/big" : `/big?${text}`;
}

/** One level up: a list or a run to its app, an app or a wall to home. */
export function backUrl(where: Where, runApp?: string): string {
  if (where.run !== undefined)
    return runApp === undefined ? "/big" : bigUrl({ app: runApp });
  if (where.app !== undefined && where.list !== undefined)
    return bigUrl({ app: where.app });
  return "/big";
}

// ---- the focus ----

/**
 * Where a step of `step` rows lands, over `count` rows, from `at` (-1 for
 * no focus yet). A first step down lands on the first row, a first step up
 * on the last; nothing ever wraps, as in vim.
 */
export function moveIndex(count: number, at: number, step: number): number {
  if (count === 0) return -1;
  const next = at < 0 ? (step > 0 ? 0 : count - 1) : at + step;
  return Math.max(0, Math.min(count - 1, next));
}

/** The next pane over, wrapping: tab from the last pane lands on the first. */
export function nextPane(count: number, at: number, step: number): number {
  if (count === 0) return -1;
  return ((((at < 0 ? 0 : at) + step) % count) + count) % count;
}

/** A half page: half the rows a pane shows, and one at least. */
export function halfPage(visible: number): number {
  return Math.max(1, Math.floor(visible / 2));
}

// ---- the command line ----

export interface Command {
  readonly name: string;
  readonly arg?: string | undefined;
  readonly does: string;
}

/** What `:` takes. `:app` is the one that needs a word after it. */
export const COMMANDS: readonly Command[] = [
  { name: "app", arg: "name", does: "open an app" },
  { name: "home", does: "every app" },
  { name: "board", does: "the wall: working, landed, decided, today" },
  { name: "map", does: "every app's map, one lane each" },
  { name: "runs", does: "this app's runs" },
  { name: "issues", does: "this app's open issues" },
  { name: "pulls", does: "this app's open pulls" },
  { name: "help", does: "the key sheet" },
  { name: "q", does: "leave for the web UI" },
];

export type Parsed =
  | { readonly kind: "go"; readonly url: string }
  | { readonly kind: "help" }
  | { readonly kind: "none" }
  | { readonly kind: "error"; readonly message: string };

/** The app a word names, from the ones the viewer can see (`owner/name`). */
export function findApp(
  word: string,
  apps: readonly string[],
): string | undefined {
  const w = word.toLowerCase();
  const exact = apps.find(
    (a) => a.toLowerCase() === w || a.toLowerCase().split("/")[1] === w,
  );
  if (exact !== undefined) return exact;
  return apps.find(
    (a) =>
      a.toLowerCase().startsWith(w) ||
      (a.toLowerCase().split("/")[1] ?? "").startsWith(w),
  );
}

/**
 * What a typed command means. `:app notes` and a bare `:notes` both open
 * the app; the list commands need an app open; anything else is an error
 * that says so, never a guess.
 */
export function parseCommand(
  text: string,
  here: { readonly app?: string | undefined; readonly apps: readonly string[] },
): Parsed {
  const words = text.trim().replace(/^:/, "").split(/\s+/).filter(Boolean);
  const head = (words[0] ?? "").toLowerCase();
  if (head === "") return { kind: "none" };
  const q = (w: Record<string, string>): string => {
    const p = new URLSearchParams(w);
    return `/big?${p.toString()}`;
  };
  if (head === "app") {
    const word = words[1];
    if (word === undefined) return { kind: "error", message: "app which?" };
    const app = findApp(word, here.apps);
    return app === undefined
      ? { kind: "error", message: `no app called ${word}` }
      : { kind: "go", url: q({ app }) };
  }
  if (head === "home") return { kind: "go", url: "/big" };
  if (head === "board") return { kind: "go", url: q({ view: "board" }) };
  if (head === "map")
    return {
      kind: "go",
      url:
        here.app === undefined
          ? q({ view: "map" })
          : q({ app: here.app, list: "map" }),
    };
  if (head === "runs" || head === "issues" || head === "pulls")
    return here.app === undefined
      ? { kind: "error", message: `open an app first, then :${head}` }
      : { kind: "go", url: q({ app: here.app, list: head }) };
  if (head === "help" || head === "?") return { kind: "help" };
  if (head === "q" || head === "quit")
    return {
      kind: "go",
      url: here.app === undefined ? "/" : `/${here.app}`,
    };
  const app = findApp(head, here.apps);
  return app === undefined
    ? { kind: "error", message: `unknown: ${head}` }
    : { kind: "go", url: q({ app }) };
}

// ---- the keys ----

export interface KeyHint {
  /** The chips, as typed: `["j", "k"]`, `["ctrl-d"]`, `["1"–"9"]`. */
  readonly keys: readonly string[];
  readonly does: string;
  /** Shown in the footer, not only on the sheet. */
  readonly foot?: boolean;
}

const MOVE: readonly KeyHint[] = [
  { keys: ["h", "j", "k", "l"], does: "move", foot: true },
  { keys: ["↑", "↓", "←", "→"], does: "move" },
  { keys: ["g", "G"], does: "top, bottom" },
  { keys: ["ctrl-d", "ctrl-u"], does: "half a page" },
  { keys: ["tab", "1"], does: "next pane, pane 1–9" },
  { keys: ["enter"], does: "open", foot: true },
  { keys: ["esc"], does: "back", foot: true },
  { keys: ["o"], does: "open in the web UI, in a new tab" },
  { keys: [":"], does: "command", foot: true },
  { keys: ["/"], does: "filter", foot: true },
  { keys: ["?"], does: "help", foot: true },
  { keys: ["f"], does: "fullscreen" },
];

const BY_VIEW: Readonly<Record<View, readonly KeyHint[]>> = {
  home: [{ keys: ["t"], does: "tell the focused app's crew", foot: true }],
  app: [
    { keys: ["s"], does: "ship the focused green pull", foot: true },
    {
      keys: ["x"],
      does: "stop the focused run, close the focused ask",
      foot: true,
    },
    { keys: ["t"], does: "tell the crew, or the focused ask", foot: true },
    { keys: ["r"], does: "runs", foot: true },
    { keys: ["i"], does: "issues", foot: true },
    { keys: ["p"], does: "pulls", foot: true },
    { keys: ["m"], does: "the map", foot: true },
  ],
  run: [
    { keys: ["t"], does: "steer it", foot: true },
    { keys: ["x"], does: "stop it", foot: true },
  ],
  board: [{ keys: ["0"], does: "every region" }],
  map: [{ keys: ["enter"], does: "open the app" }],
  list: [
    { keys: ["s"], does: "ship a green pull", foot: true },
    { keys: ["x"], does: "close it", foot: true },
  ],
};

/** Every key for a view: the shared movement first, then the view's own. */
export function keysFor(view: View): readonly KeyHint[] {
  return [...MOVE, ...BY_VIEW[view]];
}

/** The footer's line: what fits on one row, in order. */
export function footKeysFor(view: View): readonly KeyHint[] {
  return keysFor(view).filter((k) => k.foot === true);
}
