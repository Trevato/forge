/**
 * Land it as it is (#11892): credit runs out after a pull went green; the
 * pull page and the app page say so in one sentence and offer the button,
 * and pressing it lands the pull. A red pull is never offered it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { promote } from "./helpers/members.ts";
import { landable } from "../src/web/studio/land_as_is.ts";
import { landCommands } from "../src/tui/screens/landasis.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { STRANGER_NEVER_SEES } from "../src/design/first_five_minutes.ts";
import { LAND_AS_IS } from "../src/web/studio/land_as_is.ts";

describe("land it as it is", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let n = 0;

  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { cookie: `${cookie}; forge_mode=studio` }, redirect: "manual" }).then((r) => r.text());

  const pullWith = async (state: "ok" | "failed", who: User = alice, into: Repo = repo): Promise<Pull> => {
    n += 1;
    const repo = into;
    const alice = who;
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/b${n}`,
      base: "main",
      message: `Change ${n}`,
      files: [{ path: `F${n}.md`, content: `${n}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: `Change ${n}`,
      body: "A change.",
      baseBranch: "main",
      headBranch: `feature/b${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary: state === "ok" ? "check passed in 1s" : "check failed" });
    return pull;
  };

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: n++, method: "tools/call", params: { name: "merge", arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  const spendCredit = () =>
    writeFileSync(
      join(dataDir, "parent.json"),
      JSON.stringify({ credit: { token: "bearer-token-123", capUsd: 5, spentUsd: 5 } }),
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-land-as-is-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      })).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public", description: "d" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        { path: "package.json", content: '{"name":"garden","scripts":{"start":"bun run server.ts"}}\n' },
        { path: "server.ts", content: "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "garden" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const agent = await createAgent(app, alice, { username: "keeper" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "keeper").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("while the crew can go on, nothing is offered", async () => {
    // No credit file and no key: the crew has nothing to run on, so seed a key-less
    // forge with credit left.
    writeFileSync(join(dataDir, "parent.json"), JSON.stringify({ credit: { token: "bearer-token-123", capUsd: 5, spentUsd: 1 } }));
    const pull = await pullWith("ok");
    const page = await get(`/alice/garden/pulls/${pull.number}`);
    expect(page).not.toContain("data-land-as-is");
    expect(await get(`/alice/garden/pulls/${pull.number}/files`)).not.toContain("data-land-as-is");
  });

  test("credit runs out after a green pull: the sentence, the button, the preview and the key on both pages; pressing it lands", async () => {
    const pull = await pullWith("ok");
    spendCredit();
    const sentence = "The crew cannot go on: the included credit is spent.";
    for (const path of [`/alice/garden/pulls/${pull.number}`, `/alice/garden/pulls/${pull.number}/files`, "/alice/garden"]) {
      const page = await get(path);
      expect(page).toContain(sentence);
      expect(page).toContain(LAND_AS_IS);
      expect(page).toContain(`action="/alice/garden/pulls/${pull.number}/ship"`);
      expect(page).toContain(`/alice/garden/app/pull-${pull.number}/open`);
      expect(page).toContain('href="/settings/subscriptions"');
    }
    const card = (await get(`/alice/garden/pulls/${pull.number}`)).split("data-land-as-is")[1]!.split("</form>")[0]!.toLowerCase();
    for (const word of STRANGER_NEVER_SEES) expect(card.includes(word)).toBe(false);

    const pressed = await fetch(`${base}/alice/garden/pulls/${pull.number}/ship`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      redirect: "manual",
    });
    expect(pressed.status).toBe(403); // same-origin check: a foreign origin lands nothing
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).toBeNull();
    const landed = await fetch(`${base}/alice/garden/pulls/${pull.number}/ship`, {
      method: "POST",
      headers: { cookie, origin: base },
      redirect: "manual",
    });
    expect(landed.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
  });

  test("a red pull is never offered it", async () => {
    spendCredit();
    const pull = await pullWith("failed");
    const page = await get(`/alice/garden/pulls/${pull.number}`);
    expect(page).not.toContain("data-land-as-is");
    expect(await get(`/alice/garden/pulls/${pull.number}/files`)).not.toContain("data-land-as-is");
  });

  test("MCP merge action land: a green pull lands squashed, a red one is check_required, the plan carries crew", async () => {
    spendCredit();
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const green = await pullWith("ok");
    const plan = await mcp(rw, { repo: "alice/garden", number: green.number, action: "land" });
    expect(plan.value.crew).toBe("The crew cannot go on: the included credit is spent.");
    expect(getPull(app.db, repo.id, green.number)?.mergedAt).toBeNull();
    const landed = await mcp(rw, { repo: "alice/garden", number: green.number, action: "land", dryRun: false });
    expect(landed.value.strategy).toBe("squash");
    expect(getPull(app.db, repo.id, green.number)?.mergedAt).not.toBeNull();

    const red = await pullWith("failed");
    const refused = await mcp(rw, { repo: "alice/garden", number: red.number, action: "land", dryRun: false });
    expect(refused.error).toContain("check_required");
    expect(getPull(app.db, repo.id, red.number)?.mergedAt).toBeNull();
  });

  test("the app page says it once and gives one row per green pull; the terminal lists the same pulls", async () => {
    spendCredit();
    const a = await pullWith("ok");
    const b = await pullWith("ok");
    const page = await get("/alice/garden");
    expect(page.split("The crew cannot go on").length - 1).toBe(1);
    expect(page).toContain(`action="/alice/garden/pulls/${a.number}/ship"`);
    expect(page).toContain(`action="/alice/garden/pulls/${b.number}/ship"`);
    const rows = landable(app, alice, repo).map((p) => p.number);
    expect(rows).toContain(a.number);
    expect(rows).toContain(b.number);
    const session = { app, user: alice } as any;
    const ctx = { push() {}, toast() {}, invalidate() {} } as any;
    expect(landCommands(session, ctx, repo).map((c) => c.id)).toEqual(["land-as-is"]);
    expect(landCommands(session, ctx, undefined)).toEqual([]);
    // The crew can go on again: nothing is offered, in the terminal either.
    writeFileSync(join(dataDir, "parent.json"), JSON.stringify({ credit: { token: "bearer-token-123", capUsd: 5, spentUsd: 1 } }));
    expect(landCommands(session, ctx, repo)).toEqual([]);
  });

  test("a writer who is not an admin sees why there is no key link, and signed out is offered nothing", async () => {
    spendCredit();
    const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!bob.ok) throw new Error(bob.error);
    promote(app.db, bob.value);
    const bobCookie = ((await fetch(`${base}/signin`, { method: "POST", body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;
    const made = await createRepo(app, bob.value, { name: "bobs", visibility: "public", description: "d" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, bob.value, made.value, { message: "Start", files: [{ path: "a.md", content: "a\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const pull = await pullWith("ok", bob.value, made.value);
    const page = await fetch(`${base}/bob/bobs/pulls/${pull.number}`, { headers: { cookie: `${bobCookie}; forge_mode=studio` } }).then((r) => r.text());
    expect(page).toContain(LAND_AS_IS);
    expect(page).toContain("Only this forge's admin can add a key.");
    expect(page).not.toContain('href="/settings/subscriptions"');
    // Signed out, nothing is offered.
    expect(landable(app, undefined, made.value)).toEqual([]);
  });
});
