/**
 * Forge it (#7642): one press beside Fork on a repository makes a fresh forge
 * with that repository as its app and lands the person on its claim link; the
 * claim signs them in as the new forge's admin, holding the repository's files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeNameOf } from "../src/spawn/forge_it.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-claim-passphrase";

describe("forge it", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let cookie = "";
  let bobCookie = "";
  let link = "";

  const post = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${parentServers.url}${path}`, {
      method: "POST",
      headers: { origin: "https://forge.test", ...extra },
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-it-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: PASSWORD, isAdmin: true,
    });
    if (!alice.ok) throw new Error("user");
    const repo = await createRepo(parent, alice.value, { name: "Bakery_Shop" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "Bakery_Shop"), {
      branch: "main", message: "bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    useProbe(parent, () => async () => true);
    parentServers = await serve(parent);
    const bob = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "bob", email: "b@x.test", password: PASSWORD,
    });
    if (!bob.ok) throw new Error("bob");
    const open = await createRepo(parent, alice.value, { name: "open", visibility: "public" });
    if (!open.ok) throw new Error("open");
    const oc = await commitFiles(repoDir(parent.reposRoot, "alice", "open"), {
      branch: "main", message: "open",
      files: [{ path: "README.md", content: "# open\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!oc.ok) throw new Error("commit");
    const signIn = async (username: string) => {
      const res = await fetch(`${parentServers.url}/signin`, {
        method: "POST",
        headers: { origin: "https://forge.test" },
        body: new URLSearchParams({ username, password: PASSWORD }),
        redirect: "manual",
      });
      const c = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
      if (!c.includes("=")) throw new Error(`signin ${res.status}`);
      return c;
    };
    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
  }, 60_000);

  afterAll(async () => {
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the repository page offers Forge beside Fork, to a signed-in person only", async () => {
    const signedIn = await (await fetch(`${parentServers.url}/alice/Bakery_Shop`, { headers: { cookie } })).text();
    expect(signedIn).toContain('action="/alice/Bakery_Shop/forge"');
    const stranger = await (await fetch(`${parentServers.url}/alice/Bakery_Shop`)).text();
    expect(stranger).not.toContain("/forge\"");
  });

  test("a name comes from the repository and always fits", () => {
    expect(forgeNameOf("Bakery_Shop")).toBe("bakery-shop");
    expect(forgeNameOf("___")).toBe("forge");
    expect(forgeNameOf("a".repeat(60))).toHaveLength(38);
  });

  test("a stranger and a cross-origin press make nothing", async () => {
    // A private repository is not there to a stranger.
    expect((await post("/alice/Bakery_Shop/forge")).status).toBe(404);
    expect((await post("/alice/Bakery_Shop/forge", { cookie, origin: "https://evil.test" })).status).toBe(403);
    expect(await Bun.file(join(dir, "spawn", "bakery-shop.json")).exists()).toBe(false);
  });

  test("pressing it lands on the claim link, which signs in an admin holding the files", async () => {
    const res = await post("/alice/Bakery_Shop/forge", { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("cache-control")).toBe("no-store");
    link = res.headers.get("location")!;
    expect(link).toMatch(/^https:\/\/bakery-shop--forge\.test\/claim#[A-Za-z0-9_-]{43}$/);

    const ledger = await Bun.file(join(dir, "spawn", "bakery-shop.json")).json();
    const child = createApp({ dataDir: childDirOf(parent, ledger.bodyId), port: 0 });
    await firstBoot(child);
    const childServers = await serve(child);
    try {
      const claimed = await fetch(`${childServers.url}/claim`, {
        method: "POST",
        headers: { origin: childServers.url },
        body: new URLSearchParams({ token: link.split("#")[1]!, username: "maria", email: "m@x.test", password: PASSWORD }),
        redirect: "manual",
      });
      expect(claimed.status).toBe(303);
      const session = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect(session).toContain("=");
      expect(getUserByName(child.db, "maria")?.isAdmin).toBe(true);
      const repo = getRepo(child.db, "bakery-shop", "Bakery_Shop");
      expect(repo).toBeDefined();
      const home = await fetch(`${childServers.url}/`, { headers: { cookie: session } });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("maria");
    } finally {
      childServers.stop();
      child.close();
    }
  }, 30_000);

  test("pressing it again makes no second forge and shows no second link", async () => {
    const again = await post("/alice/Bakery_Shop/forge", { cookie });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toBe("/forges");
  });

  test("signed in but unable to read: a private repository is a 404 and makes no ledger entry", async () => {
    const res = await post("/alice/Bakery_Shop/forge", { cookie: bobCookie });
    expect(res.status).toBe(404);
    const page = await fetch(`${parentServers.url}/alice/Bakery_Shop`, { headers: { cookie: bobCookie } });
    expect(await page.text()).not.toContain("/forge\"");
    expect(await Bun.file(join(dir, "spawn", "bakery-shop.json")).exists()).toBe(true); // alice's, from above
    expect(await Bun.file(join(dir, "spawn", "bob.json")).exists()).toBe(false);
  });

  test("signed out on a public repository is sent to sign in and makes nothing", async () => {
    const res = await post("/alice/open/forge");
    expect(res.status).toBe(303);
    expect(res.headers.get("location") ?? "").toContain("/signin");
    expect(await Bun.file(join(dir, "spawn", "open.json")).exists()).toBe(false);
  });

  test("a reader who is not the owner may forge a public repository", async () => {
    const res = await post("/alice/open/forge", { cookie: bobCookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^https:\/\/open--forge\.test\/claim#/);
  });

  test("a refusal comes back as an escaped flash on the repository page", async () => {
    // `open_` is named `open` as well, with other apps: the door refuses with 409.
    const other = await createRepo(parent, (await getUserByName(parent.db, "alice"))!, { name: "open_", visibility: "public" });
    if (!other.ok) throw new Error("open_");
    const res = await post("/alice/open_/forge", { cookie });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/open_");
    const flash = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");
    const shown = await (await fetch(`${parentServers.url}/alice/open_`, { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(shown).toContain("Not forged:");
    expect(shown).not.toMatch(/Not forged:[^<]*<script/i);
  });
});
