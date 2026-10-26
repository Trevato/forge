/**
 * The pill's other side: from a preview, production; from production, the
 * newest preview worth opening. Plain data in, plain data out. Every address
 * is the one the forge recorded for the app, never read from a request.
 */

export interface SideApp {
  /** The forge's record of production's address. */
  readonly url: string;
}

export interface SidePreview {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  /** The forge's record of this preview's address. */
  readonly url: string;
}

export interface Side {
  readonly label: string;
  readonly url: string;
}

/** A preview someone can open: up now, or waking on request. */
const OPENABLE = new Set(["running", "asleep"]);

export function sideOf(app: SideApp, environment: string, previews: readonly SidePreview[]): Side | null {
  if (environment !== "production") return { label: "Open on production", url: app.url };
  let newest: SidePreview | undefined;
  for (const p of previews) if (OPENABLE.has(p.state) && (newest === undefined || p.number > newest.number)) newest = p;
  return newest === undefined ? null : { label: `Newest preview: #${newest.number} ${newest.title}`, url: newest.url };
}
