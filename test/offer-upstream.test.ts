/**
 * A fork ahead of its parent offers its commits upstream from its home: a
 * button into the pull form with both branches chosen, `Offered in #N` once a
 * pull is open, nothing when level, nothing for a viewer who may not open one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRole } from "../src/actions/roles.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { upstreamOffer } from "../src/actions/offer_upstream.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { offerRows } from "../src/tui/screens/about.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let users: Awaited<ReturnType<typeof mk>>[] = [];

async function mk(username: string, first: boolean) {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const signIn = async (username: string): Promise<string> => {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
};

const home = async (path: string, cookie = ""): Promise<string> => {
  const r = await fetch(`${servers.url}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  expect(r.status).toBe(200);
  return r.text();
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-offer-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  users = [await mk("hank", true), await mk("olive", false), await mk("ravi", false)];
  for (const name of ["olive", "ravi"]) {
    const promoted = setRole(app, users[0]!, name, "member");
    if (!promoted.ok) throw new Error(promoted.error);
  }
  const r = await createRepo(app, users[1]!, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, users[1]!, r.value, {
    message: "first",
    files: [{ path: "a.txt", content: "a\n" }],
  });
  const f = await forkRepo(app, users[2]!, r.value);
  if (!f.ok) throw new Error(String(f.error));
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const ownWork = async (n: number) => {
  const fork = getRepo(app.db, "ravi", "yard")!;
  for (let i = 0; i < n; i++)
    await commitToBranch(app, users[2]!, fork, {
      message: `mine ${i}`,
      files: [{ path: `m${i}-${Date.now()}.txt`, content: "x\n" }],
    });
};

test("level with its parent, the fork offers nothing", async () => {
  const h = await home("/ravi/yard", await signIn("ravi"));
  expect(h).not.toContain("commit upstream");
  expect(h).not.toContain("commits upstream");
  expect(h).not.toContain("Offered in");
});

test("ahead with no pull: a button into the pull form with both branches chosen", async () => {
  await ownWork(3);
  const h = await home("/ravi/yard", await signIn("olive"));
  expect(h).toContain("Offer 3 commits upstream");
  expect(h).toContain('href="/ravi/yard/pulls/new?head=main&amp;base=main"');
  expect(h).not.toContain("Offered in");
  const form = await home("/ravi/yard/pulls/new?head=main&base=main", await signIn("olive"));
  expect(form).toContain("olive/yard");
});

test("the drift read is a named Server-Timing phase", async () => {
  const r = await fetch(`${servers.url}/ravi/yard`, {
    headers: { cookie: await signIn("olive") },
  });
  expect(r.headers.get("server-timing") ?? "").toContain("drift");
});

test("a viewer who may not open a pull is not offered one", async () => {
  const h = await home("/ravi/yard");
  expect(h).not.toContain("Offer 3 commits upstream");
});

test("ahead with an open pull: the line links to it", async () => {
  const parent = getRepo(app.db, "olive", "yard")!;
  const fork = getRepo(app.db, "ravi", "yard")!;
  const opened = await openPull(app, users[2]!, parent, {
    title: "Mine",
    body: "",
    baseBranch: "main",
    headBranch: "main",
    headRepo: fork,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  const h = await home("/ravi/yard", await signIn("olive"));
  expect(h).toContain(`Offered in #${opened.value.number}`);
  expect(h).toContain(`href="/olive/yard/pulls/${opened.value.number}"`);
  expect(h).not.toContain("Offer 3 commits upstream");
});

test("a pull whose head is another branch does not stand for the default branch", async () => {
  const parent = getRepo(app.db, "olive", "yard")!;
  const fork = getRepo(app.db, "ravi", "yard")!;
  const own = await commitToBranch(app, users[2]!, fork, {
    message: "side",
    branch: "side",
    files: [{ path: "side.txt", content: "s\n" }],
  });
  if (!own.ok) throw new Error(String(own.error));
  const side = await openPull(app, users[2]!, parent, {
    title: "Side",
    body: "",
    baseBranch: "main",
    headBranch: "side",
    headRepo: fork,
  });
  if (!side.ok) throw new Error(String(side.error));
  const offer = upstreamOffer(app, users[0]!, fork, parent, 3);
  expect(offer?.openNumber).not.toBe(side.value.number);
  expect(offer?.head).toBe("main");
});

test("the shared offer is plain data, gated on a signed-in reader of the parent", () => {
  const parent = getRepo(app.db, "olive", "yard")!;
  const fork = getRepo(app.db, "ravi", "yard")!;
  expect(upstreamOffer(app, undefined, fork, parent, 3)).toBeNull();
  expect(upstreamOffer(app, users[0]!, fork, undefined, 3)).toBeNull();
  expect(upstreamOffer(app, users[0]!, fork, parent, 0)).toBeNull();
  expect(upstreamOffer(app, users[0]!, fork, parent, null)).toBeNull();
  const offer = upstreamOffer(app, users[0]!, fork, parent, 3)!;
  expect(offer.ahead).toBe(3);
  expect(offer.base).toBe("main");
  expect(offerRows(null)).toEqual([]);
  expect(offerRows({ ahead: 3, openNumber: null, head: "main", base: "main" })[0]![1]).toContain("o opens the pull");
  expect(offerRows({ ahead: 1, openNumber: 7, head: "main", base: "main" })[0]![1]).toContain("#7");
});

test("a writer with the Following card has one route, its Propose upstream", async () => {
  const h = await home("/ravi/yard", await signIn("ravi"));
  expect(h).toContain("See the upstream proposal");
  expect(h).not.toContain("Offered in");
  expect(h).not.toContain("pulls/new?head=main");
});
