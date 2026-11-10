/**
 * The forge's top-level pages, by name, as plain data: what the `:` prompt
 * filters, what `?` help lists, and (through `palette`) the "Go to" rows of
 * the Cmd/Ctrl K palette, which `layout.ts` builds from this list rather than
 * keeping its own. One list; a page added here appears in all three.
 */

export interface GoPage {
  /** The name typed to reach it. */
  readonly name: string;
  readonly href: string;
  /** Who is shown it: anyone, a signed-in person, or a site admin. */
  readonly who: "all" | "user" | "admin";
  /** Present when the Cmd/Ctrl K palette also lists it as a "Go to" row, in its longer wording. */
  readonly palette?: string;
}

export const GO_PAGES: readonly GoPage[] = [
  { name: "Home", href: "/", who: "all", palette: "Home" },
  { name: "Apps", href: "/apps", who: "all", palette: "Apps" },
  { name: "Explore", href: "/explore", who: "all", palette: "Explore" },
  { name: "Packs", href: "/packs", who: "all", palette: "Forge packs" },
  { name: "Front page", href: "/front", who: "all", palette: "Front page" },
  { name: "Search", href: "/search", who: "all", palette: "Search" },
  { name: "Feed", href: "/feed", who: "user" },
  { name: "Board", href: "/board", who: "user" },
  { name: "Boards", href: "/boards", who: "user" },
  { name: "Flow", href: "/flow", who: "user" },
  { name: "Asks", href: "/asks", who: "user" },
  { name: "Asked", href: "/asked", who: "user", palette: "What you asked for" },
  { name: "Notes", href: "/notes", who: "user", palette: "Notes" },
  { name: "Talk", href: "/talk", who: "user", palette: "Talk to the forge" },
  { name: "Map", href: "/map", who: "user", palette: "Map" },
  { name: "Displays", href: "/displays", who: "user", palette: "Displays" },
  { name: "Settings", href: "/settings", who: "user" },
  { name: "System", href: "/system", who: "admin" },
  { name: "Releases", href: "/releases", who: "admin" },
  { name: "Forges", href: "/forges", who: "admin" },
  { name: "Family", href: "/family", who: "admin" },
  { name: "Audit", href: "/audit", who: "admin" },
];

/** The pages this viewer may be sent to, in list order. */
export function goPagesFor(viewer: { signedIn: boolean; admin: boolean }): GoPage[] {
  return GO_PAGES.filter(
    (p) => p.who === "all" || (viewer.signedIn && (p.who === "user" || viewer.admin)),
  );
}

/** The one digit the page wears so the keys script can pick its pages: 0 a stranger, 1 signed in, 2 admin. */
export function goLevel(viewer: { signedIn: boolean; admin: boolean }): 0 | 1 | 2 {
  return !viewer.signedIn ? 0 : viewer.admin ? 2 : 1;
}

/** The list as the keys script carries it: [name, href, level needed]. */
export function goPagesData(): [string, string, number][] {
  return GO_PAGES.map((p) => [p.name, p.href, p.who === "all" ? 0 : p.who === "user" ? 1 : 2]);
}

/** The Cmd/Ctrl K palette's "Go to" rows, in list order, and which of them a stranger may see. */
export function goPaletteRows(): { t: string; h: string; visitor: boolean }[] {
  return GO_PAGES.filter((p) => p.palette !== undefined).map((p) => ({
    t: p.palette as string,
    h: p.href,
    visitor: p.who === "all",
  }));
}

/**
 * The filter, as the JavaScript the keys script ships: `goMatch(pages, q)`
 * takes [name, href, level] rows and returns those whose lower-cased name
 * contains the trimmed, lower-cased query, names that start with it first,
 * ties in list order. The first element is what Enter opens. It lives here as
 * source so the test can run the very code the browser runs.
 */
export const GO_MATCH_JS = `function goMatch(pages, q) {
  q = String(q).trim().toLowerCase();
  var hits = pages.filter(function (p) { return q === '' || p[0].toLowerCase().indexOf(q) >= 0; });
  var starts = hits.filter(function (p) { return p[0].toLowerCase().indexOf(q) === 0; });
  return starts.concat(hits.filter(function (p) { return starts.indexOf(p) < 0; }));
}`;
