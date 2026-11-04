/**
 * Propose upstream across forges (#1832): a child forge pushes its change to
 * `child/<name>/…` at its parent forge with the proposal token and opens the
 * pull there; the child shows the proposal as the parent last said it, and
 * a parent that does not answer reads as one line, never an error page.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  forgeProposals,
  proposeToParentForge,
  STATE_TTL_MS,
} from "../src/actions/upstream.ts";
import { createApp, type App } from "../src/app.ts";
import { mintProposalToken } from "../src/core/proposal_token.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { proposalLimiter } from "../src/http/proposal_gate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { Screen } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { chainScreen } from "../src/tui/screens/chain.ts";
import { checkUpstream, upstreamState } from "../src/spawn/upstream.ts";
import { keepParentCredential } from "../src/spawn/parent_credential.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-upstream-passphrase";

describe("a child forge proposes to its parent forge", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let parentServer: Servers;
  let childServer: Servers;
  let alice: User;
  let kid: User;
  let lib: Repo;
  let forge: Repo;
  let secret = "";

  const person = async (app: App, username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  /** A change landing on the child: a branch, a pull, a merge. */
  const land = async (branch: string, title: string) => {
    const c = await commitToBranch(child, kid, forge, {
      branch,
      base: "main",
      message: title,
      files: [{ path: `${branch}.md`, content: `${title}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(child, kid, forge, {
      title,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(child, kid, forge, opened.value, "merge");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return opened.value;
  };

  const forgeCount = (): number =>
    child.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM upstream_proposal").get()!.n;
  const parentPull = (number: number) => getPull(parent.db, lib.id, number)!;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-upstream-"));
    parent = createApp({ dataDir: join(dir, "parent"), port: 0, host: "parent.test" });
    parentServer = await serve(parent);
    alice = await person(parent, "alice");
    const made = await createRepo(parent, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(parent, alice, lib, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const minted = mintProposalToken(parent.db, alice.id, lib.id, {
      child: "kid",
      origin: "https://kid.example.com/",
    });
    if (!minted.ok) throw new Error(minted.error);
    secret = minted.value.token;
    // Many presses in one minute are the test's doing, not a flood.
    proposalLimiter(parent).setLimits({ perMinute: 1000, adminPerMinute: 1000, enabled: true });

    child = createApp({
      dataDir: join(dir, "child"),
      port: 0,
      host: "kid.test",
      url: "https://kid.example.com",
    });
    childServer = await serve(child);
    kid = await person(child, "kid");
    const f = await createRepo(child, kid, { name: "forge", visibility: "public" });
    if (!f.ok) throw new Error(String(f.error));
    // The child's code is a copy of the parent's: the same history.
    const there = repoDir(child.reposRoot, "kid", "forge");
    await rm(there, { recursive: true, force: true });
    const cloned = await runGit(
      ["clone", "--bare", repoDir(parent.reposRoot, "alice", "lib"), there],
      {},
    );
    if (!cloned.ok) throw new Error(String(cloned.error));
    forge = getRepo(child.db, "kid", "forge")!;
    const tip = await runGit(["rev-parse", "main"], { cwd: there });
    if (!tip.ok) throw new Error(String(tip.error));
    await Bun.write(
      join(child.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: parentServer.url,
        name: "kid",
        forgeCode: {
          repo: "kid/forge",
          upstream: "alice/lib",
          mode: "tell-me",
          tip: tip.value.trim(),
          chain: [],
        },
      }),
    );
    const kept = await keepParentCredential(child, { child: "kid", token: secret });
    if (!kept.ok) throw new Error(kept.error);
  });

  afterAll(async () => {
    await childServer.stop();
    await parentServer.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("with nothing ahead of the parent there is nothing to propose", async () => {
    const none = await proposeToParentForge(child, kid, forge);
    expect(none.ok ? "ok" : none.error).toBe("nothing_to_propose");
  });

  test("one press pushes to child/<name>/… and opens the pull, naming the change", async () => {
    const landed = await land("feat", "Add feat");
    const made = await proposeToParentForge(child, kid, forge);
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    expect(made.value.opened).toBe(true);
    expect(made.value.state).toBe("open");
    expect(made.value.branch).toMatch(/^main-[0-9a-f]{8}$/);

    const pull = parentPull(made.value.number);
    expect(pull.title).toBe("Add feat");
    expect(pull.headBranch).toBe(`child/kid/${made.value.branch}`);
    expect(pull.body).toContain(`kid/forge#${landed.number}`);
    expect(pull.body).toContain("Proposed by child kid");

    // Asking again for the same tip does not double it.
    const again = await proposeToParentForge(child, kid, forge);
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect(again.value.opened).toBe(false);
    expect(again.value.number).toBe(made.value.number);
  });

  test("a reader of the child cannot propose", async () => {
    const stranger = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "stranger",
      email: "s@forge.local",
      password: PASSWORD,
    });
    if (!stranger.ok) throw new Error(stranger.error);
    const refused = await proposeToParentForge(child, stranger.value, forge);
    expect(refused.ok ? "ok" : refused.error).toBe("forbidden");
  });

  test("the state is read from the parent, cached, and follows a merge", async () => {
    const t0 = Date.now();
    const [first] = await forgeProposals(child, forge, t0);
    expect(first!.state).toBe("open");
    expect(first!.reachable).toBe(true);
    expect(first!.url).toBe(`${parentServer.url}/alice/lib/pulls/${first!.number}`);

    // The parent merges; inside the cache window the child still says open.
    const merged = await mergePull(parent, alice, lib, parentPull(first!.number), "merge");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect((await forgeProposals(child, forge, t0 + 1000))[0]!.state).toBe("open");
    expect((await forgeProposals(child, forge, t0 + STATE_TTL_MS + 1))[0]!.state).toBe("merged");
  });

  test("a proposal token reads back its own pulls and no other", async () => {
    const own = await fetch(`${parentServer.url}/api/v1/repos/alice/lib/pulls/1`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(own.status).toBe(200);
    // A pull a person opened is not the kid's to read.
    const c = await commitToBranch(parent, alice, lib, {
      branch: "other",
      base: "main",
      message: "Other",
      files: [{ path: "other.md", content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const theirs = await openPull(parent, alice, lib, {
      title: "Not the kid's",
      baseBranch: "main",
      headBranch: "other",
    });
    if (!theirs.ok) throw new Error(JSON.stringify(theirs.error));
    for (const path of [`/pulls/${theirs.value.number}`, "/pulls/999", "/pulls", "/pulls/0"]) {
      const res = await fetch(`${parentServer.url}/api/v1/repos/alice/lib${path}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  test("a push that landed but whose pull was lost is retried, not stranded", async () => {
    await land("lost", "Add lost");
    const real = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: any, init?: any) =>
        String(input).endsWith("/alice/lib/pulls") && init?.method === "POST"
          ? new Response("{}", { status: 500 })
          : real(input, init),
      { preconnect: real.preconnect },
    ) as typeof fetch;
    try {
      const first = await proposeToParentForge(child, kid, forge);
      expect(first.ok).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
    const second = await proposeToParentForge(child, kid, forge);
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    expect(second.value.opened).toBe(true);
    expect(parentPull(second.value.number).title).toBe("Add lost");
  });

  test("the terminal lists the proposals and `p` proposes", async () => {
    await land("termed", "Add termed");
    const toasts: string[] = [];
    const ctx = { toast: (m: string) => toasts.push(m), pop() {}, push() {}, theme: {} } as any;
    const heard: any[] = [];
    const off = child.bus.subscribe((e) => e.kind === "forge.proposal" && heard.push(e));
    const screen = await chainScreen(child, kid, ctx);
    expect(screen.keys.map((k: any) => k.keys?.[0] ?? k[0])).toContain("p");
    screen.key({ key: "p" } as any);
    // Wait for what the lines below read: the press's toast and its event.
    const deadline = Date.now() + 10_000;
    while (toasts.length === 0 || heard.length === 0) {
      if (Date.now() > deadline)
        throw new Error(`after p: ${toasts.length === 0 ? "no toast" : "no forge.proposal event"} within 10 s (toasts: ${JSON.stringify(toasts)})`);
      await Bun.sleep(10);
    }
    off();
    expect(toasts.join("\n")).toContain("Proposed to the parent forge as #");
    // One event, tied to the forge's repository so only its readers hear it.
    expect(heard).toHaveLength(1);
    expect(heard[0].repoId).toBe(forge.id);
    expect(heard[0].payload).toMatchObject({ repo: "kid/forge", state: "open" });
    expect(toasts.join("\n")).toContain(`#${heard[0].payload.number}`);
  });

  test("a state the parent changes is published once, and not again while it holds", async () => {
    const open = (await forgeProposals(child, forge, Date.now() + 20 * STATE_TTL_MS)).find((p) => p.state === "open")!;
    const heard: any[] = [];
    const off = child.bus.subscribe((e) => e.kind === "forge.proposal" && heard.push(e));
    // Asked again with the parent unchanged: nothing to say.
    await forgeProposals(child, forge, Date.now() + 40 * STATE_TTL_MS);
    expect(heard).toHaveLength(0);
    parent.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number = ?2").run(lib.id, open.number);
    await forgeProposals(child, forge, Date.now() + 60 * STATE_TTL_MS);
    await forgeProposals(child, forge, Date.now() + 80 * STATE_TTL_MS);
    off();
    expect(heard).toHaveLength(1);
    expect(heard[0].payload).toMatchObject({ number: open.number, state: "closed" });
    expect(heard[0].repoId).toBe(forge.id);
  });

  test("the page button: a writer's form POST proposes; a cross-origin one is refused", async () => {
    await land("viaform", "Add viaform");
    const cookie = `forge_session=${createSession(child.db, kid.id).token}`;
    const post = (headers: Record<string, string>) =>
      fetch(`${childServer.url}/kid/forge/following/propose`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, ...headers },
      });
    const before = forgeCount();
    const evil = await post({ origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(forgeCount()).toBe(before);

    const sent = await post({ origin: "https://kid.example.com" });
    expect([302, 303]).toContain(sent.status);
    expect(new URL(sent.headers.get("location")!, childServer.url).pathname).toBe("/kid/forge/following");
    expect(forgeCount()).toBe(before + 1);

    // The same press, asking for the flash as JSON, says what happened.
    const again = await post({ origin: "https://kid.example.com", accept: "application/json" });
    const said = (await again.json()) as { ok: boolean; flash: string };
    expect(said.flash).toMatch(/^Already proposed to the parent forge as #\d+\.$/);
    const page = await fetch(`${childServer.url}/kid/forge/following`);
    expect(await page.text()).toContain("Add viaform");
  });

  test("the API door: 201 then 200, 403 for a reader", async () => {
    await land("viaapi", "Add viaapi");
    const writer = createToken(child.db, kid.id, "api", "rw").token;
    const reader = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "reader",
      email: "r@forge.local",
      password: PASSWORD,
    });
    if (!reader.ok) throw new Error(reader.error);
    const readerToken = createToken(child.db, reader.value.id, "r", "rw").token;
    const press = (token: string) =>
      fetch(`${childServer.url}/api/v1/repos/kid/forge/following/propose-parent`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await press(readerToken)).status).toBe(403);
    const first = await press(writer);
    expect(first.status).toBe(201);
    const made = (await first.json()) as { number: number; opened: boolean; state: string };
    expect(made.opened).toBe(true);
    const second = await press(writer);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { number: number }).number).toBe(made.number);
  });

  test("reading back a pull spends none of the token's minute", async () => {
    proposalLimiter(parent).setLimits({ perMinute: 2, adminPerMinute: 2, enabled: true });
    try {
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`${parentServer.url}/api/v1/repos/alice/lib/pulls/1`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        expect(res.status).toBe(200);
      }
    } finally {
      proposalLimiter(parent).setLimits({ perMinute: 1000, adminPerMinute: 1000, enabled: true });
    }
  });

  test("an unreachable parent degrades to one line, not an error page", async () => {
    await land("second", "Add second");
    const made = await proposeToParentForge(child, kid, forge);
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    expect(made.value.state).toBe("open");

    await parentServer.stop();
    const later = Date.now() + 10 * STATE_TTL_MS;
    const shown = await forgeProposals(child, forge, later);
    const second = shown.find((p) => p.number === made.value.number)!;
    expect(second.state).toBe("open");
    expect(second.reachable).toBe(false);
    // The merged one is final and is not asked about again.
    expect(shown.some((p) => p.state === "merged" && p.reachable)).toBe(true);

    const listed = await fetch(`${childServer.url}/api/v1/repos/kid/forge/following/proposals`);
    expect(listed.status).toBe(200);
    const page = await fetch(`${childServer.url}/kid/forge/following`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("parent unreachable");

    await land("third", "Add third");
    const refused = await proposeToParentForge(child, kid, forge);
    expect(refused.ok ? "ok" : refused.error).toEqual({ kind: "unreachable" });
    const api = await fetch(`${childServer.url}/api/v1/repos/kid/forge/following/propose-parent`, {
      method: "POST",
      headers: { authorization: `Bearer ${createToken(child.db, kid.id, "down", "rw").token}` },
    });
    expect(api.status).toBe(502);
    expect(((await api.json()) as { error: { code?: string } | string }).error).toBeDefined();
  });

  test("a check tells the chain page, and the terminal shows and runs it for a writer only", async () => {
    const remote = repoDir(parent.reposRoot, "alice", "lib");
    const heard: any[] = [];
    const off = child.bus.subscribe((e) => e.kind === "forge.upstream" && heard.push(e));
    const toasts: string[] = [];
    const ctx = { toast: (m: string) => toasts.push(m), pop() {}, push() {}, theme: theme("dark") } as any;
    const keysOf = (screen: any) => screen.keys.map((k: any) => k.keys?.[0] ?? k[0]);
    const text = (screen: any) => {
      const grid = new Screen(100, 30);
      screen.render({ x: 0, y: 0, w: 100, h: 30 }, grid);
      return grid.toText();
    };

    const writer = await chainScreen(child, kid, ctx);
    expect(keysOf(writer)).toContain("c");
    expect(text(writer)).toContain("not checked yet");
    await checkUpstream(child, { remote });
    expect(heard).toHaveLength(1);
    expect(heard[0].repoId).toBe(forge.id);
    expect(heard[0].actorId ?? null).toBeNull();
    expect(heard[0].payload).toMatchObject({ repo: "kid/forge", error: "" });

    writer.key({ key: "c" } as any);
    await Bun.sleep(300);
    off();
    expect(heard.length).toBeGreaterThanOrEqual(1);
    expect(toasts.join("\n")).toMatch(/checked|up to date|new commit|could not check/);

    const reader = await person(child, "looker");
    const read = await chainScreen(child, reader, ctx);
    expect(keysOf(read)).not.toContain("c");
    expect(text(read)).toContain("upstream");
    expect(keysOf(await chainScreen(child, undefined, ctx))).not.toContain("c");

    // Severed: neither the row nor the key.
    const file = join(child.config.dataDir, "parent.json");
    const doc = JSON.parse(await Bun.file(file).text());
    doc.forgeCode.severedAt = new Date().toISOString();
    await Bun.write(file, JSON.stringify(doc));
    const cut = await chainScreen(child, kid, ctx);
    expect(keysOf(cut)).not.toContain("c");
    expect(text(cut)).not.toContain("upstream");
    expect(await checkUpstream(child, { remote })).toBeUndefined();
    expect(await upstreamState(child)).toBeDefined();
  });
});
