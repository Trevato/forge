/** The palette finds issues and pulls by number, people, settings and actions (#10659). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import {
  actionRows,
  peopleRows,
  settingsRows,
} from "../src/web/palette_rows.ts";
import { rankPalette, type PaletteRow } from "../src/web/palette.ts";
import { shellJs } from "../src/web/client.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const priv = () => f.repos[1]!; // private, owned by olive

function indexOf(page: string) {
  const m = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(page);
  if (m === null) throw new Error("no palette index");
  return JSON.parse(m[1]!) as { here?: string; items: { t: string; h: string; c: string; a?: 1 }[] };
}
const read = async (path: string, cookie?: string) =>
  indexOf(await (await fetch(`${f.base}${path}`, cookie ? { headers: { cookie } } : {})).text());

test("#N is one row built by the script: issues and pulls share a number space", () => {
  expect(shellJs).toContain("hereBase + '/issues/' + num[1]");
  // One row, not an issue and a pull: the other kind's address redirects, so neither is a dead link.
  expect(shellJs).not.toContain("hereBase + '/pulls/'");
  const rows: PaletteRow[] = [{ t: "Go to #7", h: "/olive/app-0/issues/7", g: "Issues and pulls", d: "#7", k: 7 }];
  expect(rankPalette(rows, "#7", [], 10).flatMap((g) => g.rows.map((r) => r.h))).toEqual(["/olive/app-0/issues/7"]);
  expect(rankPalette(rows, "#999", [], 5)).toEqual([]);
});

test("what is sent: `here` for a stranger, a member and a non-director reader of a private repo", async () => {
  // A stranger to a private repository is told nothing of it.
  expect((await read(`/olive/${priv().name}`)).here).toBeUndefined();
  // A member who is not on it: the same.
  expect((await read(`/olive/${priv().name}`, f.peerCookie)).here).toBeUndefined();
  // Its owner, a director, gets it.
  expect((await read(`/olive/${priv().name}`, f.ownerCookie)).here).toBe(`/olive/${priv().name}`);
  // A reader who may not direct the crew (read-only through an org team) gets none of a private repo.
  const org = createOrg(f.app.db, "yardorg", f.owner.id);
  if (!org.ok) throw new Error(org.error);
  const team = createTeam(f.app.db, org.value.id, "Readers", "read");
  if (!team.ok) throw new Error(String(team.error));
  addTeamMember(f.app.db, team.value, f.peer.id);
  const made = await createRepo(f.app, org.value, { name: "ledger", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const reader = `forge_session=${createSession(f.app.db, f.peer.id).token}`;
  const page = await fetch(`${f.base}/yardorg/ledger`, { headers: { cookie: reader } });
  expect(page.status).toBe(200); // the reader does see the page...
  expect(indexOf(await page.text()).here).toBeUndefined(); // ...but the palette does not name it.
  // A public repository names itself for a signed-in reader; signed out, no repository is read at all.
  expect((await read(`/olive/app-0`, f.peerCookie)).here).toBe("/olive/app-0");
  expect((await read(`/olive/app-0`)).here).toBeUndefined();
  // And no issue or pull of any repository rides in the index.
  const all = await read(`/olive/${priv().name}`, f.ownerCookie);
  expect(all.items.some((i) => i.c === "Issues" || i.c === "Pull requests")).toBe(false);
});

test("people, settings and actions: signed-in only, only the sending one marked", async () => {
  expect(peopleRows(f.app.db, undefined)).toEqual([]);
  expect(settingsRows(undefined)).toEqual([]);
  expect(actionRows(undefined, "/x")).toEqual([]);
  expect(peopleRows(f.app.db, f.owner).map((p) => p.t)).toContain("pablo");
  expect(settingsRows(f.owner).map((s) => s.h)).toContain("/settings/password");
  const acts = actionRows(f.owner, "/olive/app-0/tell?from=%2F");
  expect(acts.map((a) => a.t)).toEqual(["Tell the crew"]);
  expect(actionRows(f.owner, undefined)).toEqual([]);
  const items = (await read("/olive/app-0", f.ownerCookie)).items;
  expect(items.filter((i) => i.a === 1).map((i) => i.t)).toEqual(["Tell the crew"]);
  const stranger = (await read("/olive/app-0")).items;
  expect(stranger.some((i) => i.a === 1 || i.c === "People" || i.c === "Actions")).toBe(false);
  // Navigation, the map and New app among it, never carries the mark.
  expect(items.filter((i) => i.h === "/map" || i.h === "/apps/new").some((i) => i.a)).toBe(false);
});

test("the script asks once, in words a thumb and a screen reader both get", () => {
  expect(shellJs).toContain("data-action");
  expect(shellJs).toContain("Tap or press Enter again to confirm");
  expect(shellJs).not.toContain("\\u2014 press Enter"); // the old Enter-only wording
  expect(shellJs).toContain("aria-live");
  expect(shellJs).toContain("aria-description");
});

test("2,000 rows: the number lands first and the list stays capped", () => {
  const rows: PaletteRow[] = Array.from({ length: 2000 }, (_, i) => ({
    t: `Issue title number ${i} about the roof`,
    h: `/o/n/issues/${i + 1}`,
    g: "Issues",
    d: `#${i + 1}`,
    k: i + 1,
  }));
  const hits = rankPalette(rows, "#1234", [], 20);
  expect(hits[0]!.rows[0]!.h).toBe("/o/n/issues/1234");
  expect(hits.flatMap((g) => g.rows).length).toBeLessThanOrEqual(20);
  expect(rankPalette(rows, "roof 17", [], 20).flatMap((g) => g.rows).length).toBeLessThanOrEqual(20);
});

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const timeMs = (run: () => void) => {
  const runs: number[] = [];
  for (let n = 0; n < 5; n++) {
    const t0 = performance.now();
    run();
    runs.push(performance.now() - t0);
  }
  return median(runs);
};

test("2,000 rows: a number, a word and two words each rank in under 50 ms (median of 5)", () => {
  const rows: PaletteRow[] = Array.from({ length: 2000 }, (_, i) => ({
    t: `Issue title number ${i} about the roof`,
    h: `/o/n/issues/${i + 1}`,
    g: "Issues",
    d: `#${i + 1} opened by someone`,
    k: i + 1,
  }));
  rankPalette(rows, "roof", [], 20); // warm the JIT: the ceiling is for the steady state
  const slowest = Math.max(
    timeMs(() => rankPalette(rows, "#1234", [], 20)),
    timeMs(() => rankPalette(rows, "roof", [], 20)),
    timeMs(() => rankPalette(rows, "title roof", [], 20)),
  );
  expect(slowest).toBeLessThan(50);
});

test("every row kind is found by its own words", () => {
  const rows: PaletteRow[] = [
    { t: "Leaky gutter on the barn", h: "/o/n/issues/7", g: "Issues", d: "#7", k: 7 },
    { t: "Repaint the fence", h: "/o/n/pulls/8", g: "Pull requests", d: "#8", k: 8 },
    { t: "pablo", h: "/pablo", g: "People" },
    { t: "Change password", h: "/settings/password", g: "Settings" },
    { t: "Tell the crew", h: "/o/n/tell", g: "Actions", a: 1 },
    { t: "Unrelated", h: "/x", g: "Pages" },
  ];
  const top = (q: string) => rankPalette(rows, q, [], 5)[0]?.rows[0]?.h;
  expect(top("gutter barn")).toBe("/o/n/issues/7");
  expect(top("#7")).toBe("/o/n/issues/7");
  expect(top("repaint fence")).toBe("/o/n/pulls/8");
  expect(top("#8")).toBe("/o/n/pulls/8");
  expect(top("pablo")).toBe("/pablo");
  expect(top("password")).toBe("/settings/password");
  expect(top("tell crew")).toBe("/o/n/tell");
});
