/**
 * #7756: the Fork tree test, on the web, on one forge. A person looks at a
 * fork's page and sees its parent and its child as a tree, chooses how it
 * follows, and offers its own commit up in one POST from the offer page.
 * A plain in-forge fork chooses among three modes on its page and its forks
 * page (#7796, #608).
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
import { listEvents } from "../src/core/events.ts";
import { createToken } from "../src/core/tokens.ts";
import { followModeSaid, setFollowMode } from "../src/actions/follow.ts";
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

  test("a plain fork's page says how it follows in one line; the admin switches it after a confirm, a stranger and a cross-origin post change nothing", async () => {
    const cookie = await signIn("bea");
    const before = await (await get("/bea/yard", cookie)).text();
    expect(before).toContain("Proposes updates from ann/yard");
    expect(before).not.toContain("automatically</strong>");
    expect(before).toContain("/-/confirm?to=%2Fbea%2Fyard%2Ffollowing%2Fmode%2Ftake-updates");

    const confirm = await (await get("/-/confirm?to=%2Fbea%2Fyard%2Ffollowing%2Fmode%2Ftake-updates", cookie)).text();
    expect(confirm).toContain("Follows ann/yard automatically?");
    expect(confirm).toContain("the crew is told to converge");
    expect(confirm).toContain('action="/bea/yard/following/mode/take-updates"');

    const cross = await post("/bea/yard/following/mode/take-updates", cookie, {}, "https://evil.test");
    expect(cross.status).toBe(403);
    const stranger = await post("/bea/yard/following/mode/take-updates", await signIn("cal"), {});
    expect(stranger.status).toBe(303);
    expect(forkFollowMode(app.db, middle.id)).toBe("tell-me");

    const audits = () => listEvents(app.db, { kind: "forge.follow_mode" });
    const audited = audits().length;
    const changed = await post("/bea/yard/following/mode/take-updates", cookie, {});
    expect(changed.status).toBe(303);
    expect(changed.headers.get("location")).toBe("/bea/yard/following");
    expect(forkFollowMode(app.db, middle.id)).toBe("take-updates");
    expect(audits().length).toBe(audited + 1);
    const receipt = audits()[0]!;
    expect(receipt.repoId).toBe(middle.id);
    expect(receipt.actorId).toBe(bea.id);
    expect(receipt.payload).toMatchObject({ repo: "bea/yard", mode: "take-updates" });

    const after = await (await get("/bea/yard", cookie)).text();
    expect(after).toContain("Follows ann/yard automatically");
    expect(after).toContain('data-follow-mode="take-updates"');
    expect(after).toContain("Only propose updates");

    // A reader sees the line but no switch.
    const reader = await (await get("/bea/yard", await signIn("cal"))).text();
    expect(reader).toContain("Follows ann/yard automatically");
    expect(reader).not.toContain("following%2Fmode");

    const bad = await post("/bea/yard/following/mode", cookie, { mode: "nope" });
    expect(bad.status).toBe(303);
    expect(forkFollowMode(app.db, middle.id)).toBe("take-updates");
  });

  test("the confirm for tell-me says it only proposes; a non-writer sees 'its parent'; a root repository has no line", async () => {
    const confirm = await (await get("/-/confirm?to=%2Fbea%2Fyard%2Ffollowing%2Fmode%2Ftell-me", await signIn("bea"))).text();
    expect(confirm).toContain("Proposes updates from ann/yard?");
    expect(confirm).toContain("nothing is merged until you take it");
    const stranger = await (await get("/-/confirm?to=%2Fbea%2Fyard%2Ffollowing%2Fmode%2Ftell-me", await signIn("cal"))).text();
    expect(stranger).toContain("Proposes updates from its parent?");
    expect(stranger).not.toContain("from ann/yard");
    const root = await (await get("/ann/yard", await signIn("ann"))).text();
    expect(root).not.toContain("data-follow-mode");
    expect(followModeSaid(undefined, "tell-me")).toContain("Proposes updates from its parent.");
  });

  test("the forks page lets the fork's owner choose any of three modes, and not a reader (#608)", async () => {
    const cookie = await signIn("bea");
    const forks = await (await get("/bea/yard/forks", cookie)).text();
    expect(forks).toContain('id="following"');
    expect(forks).toContain("data-follow-mode=");
    // The card on its own forks page does not link back to it.
    expect(forks).not.toContain("forks follow this one");
    const now = forkFollowMode(app.db, middle.id);
    const others = (["take-updates", "tell-me", "dont-follow"] as const).filter((m) => m !== now);
    for (const m of others) expect(forks).toContain(`following%2Fmode%2F${m}"`);
    expect(forks).not.toContain(`following%2Fmode%2F${now}"`);

    const reader = await (await get("/bea/yard/forks", await signIn("cal"))).text();
    expect(reader).not.toContain('id="following"');
    expect(reader).toContain('aria-label="Forks, by who follows whom"');

    const confirm = await (await get("/-/confirm?to=%2Fbea%2Fyard%2Ffollowing%2Fmode%2Fdont-follow", cookie)).text();
    expect(confirm).toContain("Does not follow ann/yard?");
    expect(confirm).toContain("the crew is never asked to converge");
    const changed = await post("/bea/yard/following/mode/dont-follow", cookie, {});
    expect(changed.status).toBe(303);
    expect(forkFollowMode(app.db, middle.id)).toBe("dont-follow");
    const after = await (await get("/bea/yard/forks", cookie)).text();
    expect(after).toContain("Does not follow ann/yard");
    expect(after).toContain("Follow automatically");
    expect(after).toContain("Only propose updates");
    expect(after).not.toContain("Stop following");
    must(await setFollowMode(app, bea, middle, "tell-me"));
  });

  test("MCP: following returns the mode, follow_mode sets any of the three; a stranger is refused (#608)", async () => {
    let id = 1;
    const call = async (who: User, name: string, args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${createToken(app.db, who.id, "t", "rw").token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
      });
      const j = (await res.json()) as any;
      return { error: j.result.isError === true, text: String(j.result.content[0].text) };
    };
    const set = await call(bea, "follow_mode", { repo: "bea/yard", mode: "dont-follow" });
    expect(set.error).toBe(false);
    expect(JSON.parse(set.text).mode).toBe("dont-follow");
    const read = await call(bea, "following", { repo: "bea/yard" });
    expect(JSON.parse(read.text).mode).toBe("dont-follow");
    const tree = await call(bea, "fork_tree", { repo: "bea/yard" });
    expect(JSON.parse(tree.text).nodes.find((n: { repo: string }) => n.repo === "bea/yard").follow).toBe("dont-follow");
    expect((await call(cal, "follow_mode", { repo: "bea/yard", mode: "take-updates" })).error).toBe(true);
    expect(forkFollowMode(app.db, middle.id)).toBe("dont-follow");
    must(await setFollowMode(app, bea, middle, "tell-me"));
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
    // The door is the Following card's "Offer this change" form: read its
    // action and fields off the page, then send exactly that.
    const home = await (await get("/bea/yard", cookie)).text();
    const formTag = home.match(/<form method="post" action="([^"]+)">\s*<input type="hidden" name="do" value="propose"/);
    expect(formTag).not.toBeNull();
    expect(home).toContain("Offer this change");
    // The forks page carries the same card for its owner (#608): the
    // offer, and the tree saying the fork is one ahead.
    const forks = await (await get("/bea/yard/forks", cookie)).text();
    expect(forks).toContain("Offer this change");
    expect(forks.slice(forks.indexOf('aria-label="Forks, by who follows whom"'))).toContain("1 ahead");
    const sent = await post(formTag![1]!, cookie, { do: "propose" });
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/ann/yard/pulls/1");

    const list = await (await get("/ann/yard/pulls", await signIn("ann"))).text();
    expect(new Set(list.match(/\/ann\/yard\/pulls\/\d+"/g)).size).toBe(1);
    expect(await (await get("/bea/yard", cookie)).text()).toContain("See the upstream proposal");
    expect(await (await get("/ann/yard/pulls/2", cookie)).status).toBe(404);
  });
});
