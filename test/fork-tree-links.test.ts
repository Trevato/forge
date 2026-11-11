/**
 * #11321: the fork tree is for browsing. Every node is a link, the viewer's
 * own forge says "you" in words, and a private fork's name is not on the page.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const mk = async (username: string, first: boolean): Promise<User> =>
  must(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    }),
  );
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fork-tree-links-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const ann = await mk("ann", true);
  const bea = await mk("bea", false);
  const cal = await mk("cal", false);
  const dee = await mk("dee", false);
  for (const n of ["bea", "cal", "dee"]) must(setRole(app, ann, n, "member"));
  const root = must(await createRepo(app, ann, { name: "yard", visibility: "public" }));
  must(await commitToBranch(app, ann, root, { message: "first", files: [{ path: "a.txt", content: "a\n" }] }));
  const middle = must(await forkRepo(app, bea, root));
  must(await forkRepo(app, cal, middle));
  must(await forkRepo(app, dee, middle, undefined, { visibility: "private" }));
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("every readable node links, the viewer's own says you, a private fork is absent", async () => {
  const cookie = await signIn("bea");
  const body = await (await fetch(`${servers.url}/ann/yard/forks`, { headers: { cookie } })).text();
  const from = body.indexOf('aria-label="Forks, by who follows whom"');
  const tree = body.slice(from, body.indexOf("</section>", from));
  for (const h of ["/ann/yard", "/bea/yard", "/cal/yard"]) expect(tree).toContain(`href="${h}"`);
  // One <li> per node, split at the row's own opening tag; only bea's carries "you".
  const rows = new Map<string, string>();
  for (const m of tree.matchAll(/<a href="(\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) rows.set(m[1]!, m[2]!);
  expect([...rows.keys()].sort()).toEqual(["/ann/yard", "/bea/yard", "/cal/yard"]);
  const marked = (h: string): boolean => /<[^>]*>you<\//.test(rows.get(h)!);
  expect(marked("/bea/yard")).toBe(true);
  expect(marked("/ann/yard")).toBe(false);
  expect(marked("/cal/yard")).toBe(false);
  // dee's private fork is neither linked nor named.
  expect(body).not.toContain("dee/yard");

  // On her own page the row is the current one, in words and in aria.
  const own = await (await fetch(`${servers.url}/bea/yard/forks`, { headers: { cookie } })).text();
  expect(own).toContain("you are here");
  expect(own).toContain('aria-current="true"');
});

test("the terminal tree marks the viewer's own forks, not the asked one, as the page does", async () => {
  const { treeLines } = await import("../src/tui/screens/fork_tree.ts");
  const node = (repo: string, parent: string | null, depth: number) => ({ repo, parent, depth, follow: "autonomous" as const, word: "" });
  const tree = {
    root: "ann/yard",
    truncated: false,
    nodes: [node("ann/yard", null, 0), node("bea/yard", "ann/yard", 1), node("cal/yard", "bea/yard", 2)],
  };
  expect(treeLines(tree, "cal/yard", 80, "bea")).toEqual(["ann/yard", "  bea/yard  (you)", "    * cal/yard"]);
  expect(treeLines(tree, "bea/yard", 80, "bea")).toEqual(["ann/yard", "  * bea/yard", "    cal/yard"]);
  expect(treeLines(tree, "ann/yard")).toEqual(["* ann/yard", "  bea/yard", "    cal/yard"]);
});
