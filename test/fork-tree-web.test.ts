/**
 * #7756: the Fork tree test, on the web, on one forge. A person looks at a
 * fork's page and sees its parent and its child as a tree, chooses how it
 * follows, and offers its own commit up in one POST from the offer page.
 *
 * The mode step is covered only for the forge's own code: the follow modes
 * exist nowhere else, so the middle fork is made that repository by hand.
 * A plain in-forge fork offers no mode choice; that step is missing, and is
 * #7796.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forkFollowMode } from "../src/core/fork_follow.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let ann: User;
let bea: User;
let cal: User;
let middle: Repo;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function mk(username: string, first: boolean): Promise<User> {
  return must(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    }),
  );
}

const signIn = async (username: string): Promise<string> =>
  (
    (
      await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username, password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;

const get = (path: string, cookie: string) =>
  fetch(`${servers.url}${path}`, { headers: { cookie } });

const post = (path: string, cookie: string, body: Record<string, string>, origin = servers.url) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { cookie, origin },
    body: new URLSearchParams(body),
    redirect: "manual",
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-tree-web-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  ann = await mk("ann", true);
  bea = await mk("bea", false);
  cal = await mk("cal", false);
  for (const name of ["bea", "cal"]) must(setRole(app, ann, name, "member"));
  const original = must(await createRepo(app, ann, { name: "yard", visibility: "public" }));
  must(
    await commitToBranch(app, ann, original, {
      message: "first",
      files: [{ path: "a.txt", content: "a\n" }],
    }),
  );
  middle = must(await forkRepo(app, bea, original));
  must(await forkRepo(app, cal, middle));
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the fork tree, on one forge", () => {
  test("the middle fork's page names its parent, and one tap on its forks shows the tree", async () => {
    const cookie = await signIn("bea");
    const home = await (await get("/bea/yard", cookie)).text();
    expect(home).toContain('id="following"');
    expect(home).toContain('href="/ann/yard"');
    expect(home).toContain('href="/bea/yard/forks"');

    const res = await get("/bea/yard/forks", cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('aria-label="Forks, by who follows whom"');
    expect(body).toContain("you are here");
    // Root, middle and child appear in that order, each linked.
    const tree = body.slice(body.indexOf('aria-label="Forks, by who follows whom"'));
    const at = ["/ann/yard", "/bea/yard", "/cal/yard"].map((h) => tree.indexOf(`href="${h}"`));
    expect(at[0]).toBeGreaterThan(-1);
    expect(at[0]).toBeLessThan(at[1]!);
    expect(at[1]).toBeLessThan(at[2]!);
    // "you are here" marks bea's entry, and neither the root's nor the child's.
    const mark = tree.indexOf("you are here");
    expect(mark).toBeGreaterThan(at[1]!);
    expect(mark).toBeLessThan(at[2]!);
    expect(tree.indexOf("you are here", mark + 1)).toBe(-1);
  });

  test("a plain fork's page offers the modes; posting one changes it, and the page shows it", async () => {
    const cookie = await signIn("bea");
    const before = await (await get("/bea/yard", cookie)).text();
    expect(before).toContain('name="mode" value="tell-me"');
    expect(before).toContain('name="mode" value="take-updates"');
    expect(before).toMatch(/value="tell-me"\s+checked/);

    const cross = await post("/bea/yard/following/mode", cookie, { mode: "take-updates" }, "https://evil.test");
    expect(cross.status).toBe(403);
    expect(forkFollowMode(app.db, middle.id)).toBe("tell-me");

    const changed = await post("/bea/yard/following/mode", cookie, { mode: "take-updates" });
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toBe("/bea/yard/following");
    expect(forkFollowMode(app.db, middle.id)).toBe("take-updates");

    const after = await (await get("/bea/yard", cookie)).text();
    expect(after).toMatch(/value="take-updates"\s+checked/);
    expect(after).not.toMatch(/value="tell-me"\s+checked/);

    // A reader without write access is not offered the form.
    const reader = await (await get("/bea/yard", await signIn("cal"))).text();
    expect(reader).not.toContain('name="mode"');
    expect(await (await fetch(`${servers.url}/bea/yard`)).text()).not.toContain('name="mode"');
    expect(after).toContain("How this fork follows its parent");

    const bad = await post("/bea/yard/following/mode", cookie, { mode: "nope" });
    expect(bad.status).toBe(303);
    expect(forkFollowMode(app.db, middle.id)).toBe("take-updates");
  });

  test("one POST from the offer page opens exactly one pull on the parent", async () => {
    const cookie = await signIn("bea");
    const fork = getRepo(app.db, "bea", "yard")!;
    must(
      await commitToBranch(app, bea, fork, {
        message: "mine",
        files: [{ path: "mine.txt", content: "m\n" }],
      }),
    );
    // The door is the Following card's "Propose upstream" form: read its
    // action and fields off the page, then send exactly that.
    const home = await (await get("/bea/yard", cookie)).text();
    const formTag = home.match(/<form method="post" action="([^"]+)">\s*<input type="hidden" name="do" value="propose"/);
    expect(formTag).not.toBeNull();
    expect(home).toContain("Propose upstream");
    const sent = await post(formTag![1]!, cookie, { do: "propose" });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/ann/yard/pulls/1");

    const list = await (await get("/ann/yard/pulls", await signIn("ann"))).text();
    expect(new Set(list.match(/\/ann\/yard\/pulls\/\d+"/g)).size).toBe(1);
    expect(await (await get("/bea/yard", cookie)).text()).toContain("See the upstream proposal");
    expect(await (await get("/ann/yard/pulls/2", cookie)).status).toBe(404);
  });
});
