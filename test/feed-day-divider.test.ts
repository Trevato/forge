/** The home timeline draws a day divider before the first post of each UTC day, never twice. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { dayKeepJs } from "../src/web/studio/feed.ts";
import { promote } from "./helpers/members.ts";
import { freshHome } from "./helpers/home-fresh.ts";

const dividerLabels = (text: string): string[] => [...text.matchAll(/data-day-divider="([^"]+)"/g)].map((m) => m[1]!);

describe("day dividers on the home timeline", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  let repoId = "";
  let aliceId = "";

  const get = (path: string) => freshHome(servers.url, cookie, path);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-day-divider-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    let alice: User | undefined;
    for (const [name, first] of [["root", true], ["alice", false]] as const) {
      const r = await createUser(app.db, { origin: "seed", trusted: true, username: name, allowReserved: true, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      if (name === "alice") alice = r.value;
    }
    cookie = `forge_session=${createSession(app.db, alice!.id).token}`;
    const made = await createRepo(app, alice!, { name: "open", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    repoId = made.value.id;
    aliceId = alice!.id;
    // Two posts on each of three days, written in the past by hand.
    const day = 86_400_000;
    [0, 1, 5].forEach((ago, d) => {
      for (let i = 0; i < 2; i++) {
        const e = app.bus.append({ kind: "run.finished", repoId: made.value.id, actorId: alice!.id, payload: { kind: "agent", state: "ok", summary: `work ${d}-${i}`, runId: `r${d}${i}` } });
        app.db.query("UPDATE event SET created_at = ?1 WHERE id = ?2").run(new Date(Date.now() - ago * day - i * 1000).toISOString(), e.id);
      }
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("three days give three dividers in order, once each", async () => {
    const labels = dividerLabels(await get("/feed"));
    expect(labels).toHaveLength(3);
    expect(labels.slice(0, 2)).toEqual(["Today", "Yesterday"]);
  });

  test("the next page and its live fragment add no divider already on the page", async () => {
    for (let i = 0; i < 25; i++) {
      const e = app.bus.append({ kind: "run.finished", repoId: repoId, actorId: aliceId, payload: { kind: "agent", state: "ok", summary: `more ${i}`, runId: `m${i}` } });
      app.db.query("UPDATE event SET created_at = ?1 WHERE id = ?2").run(new Date(Date.now() - i * 1000).toISOString(), e.id);
    }
    const first = await get("/feed");
    expect(dividerLabels(first)[0]).toBe("Today");
    const href = /href="(\/feed\?cursor=[^"]+)"[^>]*>Older posts/.exec(first)![1]!.replaceAll("&amp;", "&");
    const older = await get(href);
    expect(older).toContain("data-item=");
    expect(dividerLabels(older)).not.toContain("Today");
    const live = await get(href.replace("/feed?", "/live/feed?"));
    expect(dividerLabels(live)).toEqual(dividerLabels(older));
  });

  test("a day that is not a time is ignored", async () => {
    const text = await get(`/live/feed?cursor=${encodeURIComponent("1|zzz")}&day=%3Cscript%3E`);
    expect(text).not.toContain("<script>");
  });
});

describe("a divider goes with its card when the card is hidden", () => {
  type El = { hasAttribute(a: string): boolean; hidden: boolean; attrs: Set<string>; parentNode: { insertBefore(a: El, b: El): void }; previousElementSibling: El | null; nextElementSibling: El | null };
  const keepDay = new Function(`${dayKeepJs}; return keepDay;`)() as (card: El) => void;
  const row = (list: El[], attr: string): El => {
    const e = { hidden: false, attrs: new Set([attr]), hasAttribute(a: string) { return a === attr; }, previousElementSibling: null, nextElementSibling: null, parentNode: null } as unknown as El;
    e.parentNode = { insertBefore: (a, b) => { list.splice(list.indexOf(a), 1); list.splice(list.indexOf(b), 0, a); link(list); } };
    list.push(e);
    return e;
  };
  const link = (list: El[]) => list.forEach((e, i) => { e.previousElementSibling = list[i - 1] ?? null; e.nextElementSibling = list[i + 1] ?? null; });

  test("the only post of a day: its divider is hidden", () => {
    const l: El[] = [];
    const d1 = row(l, "data-day-divider"), a = row(l, "data-item"), d2 = row(l, "data-day-divider"), b = row(l, "data-item");
    link(l);
    a.hidden = true;
    keepDay(a);
    expect(d1.hidden).toBe(true);
    expect(d2.hidden).toBe(false);
    expect(b.hidden).toBe(false);
  });

  test("one of several posts of a day: the divider moves to the next showing", () => {
    const l: El[] = [];
    const d = row(l, "data-day-divider"), a = row(l, "data-item"), b = row(l, "data-item");
    link(l);
    a.hidden = true;
    keepDay(a);
    expect(d.hidden).toBe(false);
    expect(l.indexOf(d)).toBe(l.indexOf(b) - 1);
  });
});
