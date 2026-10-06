/**
 * Bulk asks (#690): select many, preview, act once, undo — by page, API and
 * MCP — as a fleet operation, so every row is checked against the actor's
 * own access and a refused row never stops the others. The refusals come
 * first: an outsider and a plain reader act on nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { holdPull, releasePull } from "../src/actions/holds.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAgentByName, setCrewRole } from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-bulk-passphrase";

describe("acting on many asks at once", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceRw = "";
  let aliceRo = "";
  let bobRw = "";
  let aliceCookie = "";
  let open: Repo; // public
  let quiet: Repo; // private, with a planner

  const items = (user: User): string[] =>
    askLinesFor(app.db, user).flatMap((r) => r.items);

  const api = async (token: string, path: string, payload: unknown) => {
    const res = await fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** Post a form as alice; a redirect is followed, as a browser would, to the one screen. */
  const form = async (path: string, fields: [string, string][]) => {
    const headers = { cookie: `${aliceCookie}; forge_mode=studio`, origin: servers.url };
    const res = await fetch(`${servers.url}${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (res.status === 303 && location !== null) {
      expect(location).toStartWith("/asks?op=");
      const next = await fetch(`${servers.url}${location}`, { headers, redirect: "manual" });
      expect(next.status).toBe(200);
      return (await next.text()).replace(/\s+/g, " ");
    }
    expect(res.status).toBe(200);
    return (await res.text()).replace(/\s+/g, " ");
  };

  const check = (pull: Pull, state: "ok" | "failed"): void => {
    const run = createRun(app.db, {
      repoId: pull.repoId,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary: state });
  };

  let n = 0;
  const greenPull = async (repo: Repo, title: string): Promise<Pull> => {
    n++;
    await commitToBranch(app, alice, repo, {
      branch: `bot/${n}`,
      base: "main",
      message: title,
      files: [{ path: `F${n}.md`, content: `${n}\n` }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title,
      body: "",
      baseBranch: "main",
      headBranch: `bot/${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    check(opened.value, "ok");
    return opened.value;
  };

  const parked = (repo: Repo, title: string): Issue => {
    const made = openIssue(app, alice, repo, { title });
    if (!made.ok) throw new Error(String(made.error));
    expect(addComment(app, alice, repo, made.value, BREAKER_NOTE).ok).toBe(
      true,
    );
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-bulk-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    aliceCookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    await createAgent(app, alice, { username: "bot" });
    await createAgent(app, alice, { username: "planner" });
    for (const [name, visibility] of [
      ["open", "public"],
      ["quiet", "private"],
    ] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      await commitToBranch(app, alice, made.value, {
        message: "seed",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      addToCrew(app, alice, made.value, "bot");
      addToCrew(app, alice, made.value, "planner");
      setCrewRole(
        app.db,
        made.value.id,
        getAgentByName(app.db, "planner")!.user.id,
        "planner",
      );
      if (name === "open") open = made.value;
      else quiet = made.value;
    }
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an outsider and a plain reader act on nothing: every ask is skipped", async () => {
    await greenPull(open, "Public work");
    await greenPull(quiet, "Private work");
    const mine = items(alice);
    expect(mine).toHaveLength(2);
    // Bob reads the public repository, and cannot see the private one.
    const tried = await api(bobRw, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: mine,
      preview: false,
    });
    expect(tried.status).toBe(201);
    expect(tried.body.rows).toHaveLength(0);
    expect(tried.body.skipped.map((s: { reason: string }) => s.reason)).toEqual(
      ["it no longer asks you", "it no longer asks you"],
    );
    expect(items(alice)).toHaveLength(2);
  });

  test("a preview changes nothing, and needs only a read credential; acting needs rw", async () => {
    const mine = items(alice);
    const preview = await api(aliceRo, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: mine,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.counts).toEqual({
      change: 2,
      unchanged: 0,
      refused: 0,
    });
    expect(items(alice)).toHaveLength(2);
    const ro = await api(aliceRo, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: mine,
      preview: false,
    });
    expect(ro.status).toBe(403);
  });

  test("dismiss many, then undo once; nobody else can undo it", async () => {
    const mine = items(alice);
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: mine,
      preview: false,
    });
    expect(done.status).toBe(201);
    expect(done.body.rows.map((r: { outcome: string }) => r.outcome)).toEqual([
      "ok",
      "ok",
    ]);
    expect(items(alice)).toHaveLength(0);
    const stranger = await api(
      bobRw,
      `/api/v1/asks/bulk/${done.body.id}/undo`,
      {},
    );
    expect(stranger.status).toBe(404);
    const undone = await api(
      aliceRw,
      `/api/v1/asks/bulk/${done.body.id}/undo`,
      {},
    );
    expect(undone.status).toBe(201);
    expect(items(alice)).toHaveLength(2);
    const again = await api(
      aliceRw,
      `/api/v1/asks/bulk/${done.body.id}/undo`,
      {},
    );
    expect(again.status).toBe(409);
  });

  test("the asks' undo reverses only an asks operation", async () => {
    const fleet = await fetch(`${servers.url}/api/v1/fleet/ops`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, alice.id, "admin", "admin").token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: "repo name:quiet",
        action: { verb: "slots", value: 2 },
        dryRun: false,
      }),
    });
    expect(fleet.status).toBe(201);
    const op = (await fleet.json()) as { id: string };
    const res = await api(aliceRw, `/api/v1/asks/bulk/${op.id}/undo`, {});
    expect(res.status).toBe(404);
  });

  test("a mixed batch acts on the rows it may and names the rest", async () => {
    const red = await greenPull(quiet, "Red now");
    check(red, "failed");
    const stale = parked(quiet, "Parked work");
    const mine = items(alice);
    const picked = [...mine, `paused:${quiet.id}`, `look:${red.id}`];
    const shipped = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "ship",
      items: picked,
      preview: false,
    });
    expect(shipped.status).toBe(201);
    const outcome = Object.fromEntries(
      shipped.body.rows.map(
        (r: { label: string; outcome: string; reason: string }) => [
          r.label,
          `${r.outcome} ${r.reason}`.trim(),
        ],
      ),
    );
    expect(outcome["alice/open#1"]).toBe("ok");
    expect(outcome["alice/quiet#1"]).toBe("ok");
    expect(outcome[`alice/quiet#${stale.number}`]).toBe("refused not a change");
    expect(shipped.body.skipped).toHaveLength(2);
    const ok = shipped.body.rows.filter((r: { outcome: string }) => r.outcome === "ok");
    for (const r of ok) expect(getIssueById(app.db, r.targetId)!.state).toBe("closed");
    const undo = await api(
      aliceRw,
      `/api/v1/asks/bulk/${shipped.body.id}/undo`,
      {},
    );
    expect(undo.status).toBe(422);
  });

  test("hand back to the planner: a private repository's issue, never a public one's", async () => {
    const opened = parked(open, "Public parked");
    const closedOff = parked(quiet, "Private parked again");
    const picked = [`parked:${opened.id}`, `parked:${closedOff.id}`];
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "replan",
      items: picked,
      preview: false,
    });
    expect(done.status).toBe(201);
    const byLabel = Object.fromEntries(
      done.body.rows.map(
        (r: { label: string; outcome: string; reason: string }) => [r.label, r],
      ),
    );
    expect(byLabel[`alice/open#${opened.number}`].outcome).toBe("refused");
    expect(byLabel[`alice/open#${opened.number}`].reason).toContain("public");
    expect(getIssueById(app.db, opened.id)!.assigneeName).toBeNull();
    expect(getIssueById(app.db, closedOff.id)!.assigneeName).toBe("planner");
  });

  test("an agent may preview but never act", async () => {
    const bot = getUserByName(app.db, "bot")!;
    const token = createToken(app.db, bot.id, "rw", "rw").token;
    const res = await api(token, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: [`look:x`],
      preview: false,
    });
    expect(res.status).toBe(403);
  });

  test("the page: select, preview, do it, undo", async () => {
    await greenPull(open, "Page one");
    await greenPull(open, "Page two");
    const asks = await fetch(`${servers.url}/asks`, {
      headers: { cookie: `${aliceCookie}; forge_mode=studio` },
    }).then((r) => r.text());
    expect(asks).toContain('id="asks-bulk"');
    expect(asks).toContain("data-select-all");
    const picked = items(alice).filter((i) => i.startsWith("look:"));
    expect(picked.length).toBeGreaterThanOrEqual(2);
    const fields = (extra: [string, string][]) => [
      ["action", "dismiss"] as [string, string],
      ...picked.map((i) => ["item", i] as [string, string]),
      ...extra,
    ];
    const preview = await form("/asks/bulk", fields([]));
    expect(preview).toContain(`Dismiss: ${picked.length} of ${picked.length}`);
    expect(preview).toContain('name="apply" value="1"');
    // One screen: the preview sits on top of the asks, the picked ones still ticked.
    expect(preview).toContain('id="asks-sentence"');
    expect((preview.match(/form="asks-bulk" checked/g) ?? []).length).toBe(picked.length);
    expect(items(alice).filter((i) => i.startsWith("look:"))).toHaveLength(
      picked.length,
    );
    const done = await form("/asks/bulk", fields([["apply", "1"]]));
    expect(done).toContain(`Dismiss: ${picked.length} done`);
    expect(items(alice).filter((i) => i.startsWith("look:"))).toHaveLength(0);
    const undo = /action="(\/asks\/bulk\/[^"]+\/undo)"/.exec(done)?.[1];
    expect(undo).toBeDefined();
    const back = await form(undo!, []);
    expect(back).toContain("Dismiss undone");
    expect(items(alice).filter((i) => i.startsWith("look:"))).toHaveLength(
      picked.length,
    );
  });

  test("the MCP previews the same plan", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${aliceRw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "asks_act",
          arguments: { action: "close", items: items(alice) },
        },
      }),
    });
    const body = (await res.json()) as {
      result: { content: { text: string }[] };
    };
    const plan = JSON.parse(body.result.content[0]!.text) as {
      verb: string;
      counts: { change: number };
    };
    expect(plan.verb).toBe("close");
    expect(plan.counts.change).toBeGreaterThan(0);
  });
  test("a writer, not an admin, may dismiss their own asks in bulk, and nothing more", async () => {
    const org = createOrg(app, alice, "guild");
    if (!org.ok) throw new Error(String(org.error));
    const team = createTeam(app, alice, org.value, "writers", "write");
    if (!team.ok) throw new Error(String(team.error));
    expect(addTeamMember(app, alice, org.value, team.value, "bob").ok).toBe(true);
    const made = await createRepo(app, alice, { name: "shared", visibility: "private", owner: "guild" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# shared\n" }],
    });
    addToCrew(app, alice, made.value, "bot");
    const pull = await greenPull(made.value, "Shared work");
    const ask = `look:${pull.id}`;
    expect(items(bob)).toContain(ask);
    const ship = await api(bobRw, "/api/v1/asks/bulk", { action: "ship", items: [ask], preview: false });
    expect(ship.body.rows[0].outcome).toBe("refused");
    expect(ship.body.rows[0].reason).toContain("not an admin");
    const dismiss = await api(bobRw, "/api/v1/asks/bulk", { action: "dismiss", items: [ask], preview: false });
    expect(dismiss.body.rows[0].outcome).toBe("ok");
    expect(items(bob)).not.toContain(ask);
    // Bob's dismissal is his: alice is still asked.
    expect(items(alice)).toContain(ask);
  });

  test("nobody else undoes a person's bulk action through the asks, a site admin included", async () => {
    const mine = items(alice).filter((i) => i.startsWith("look:"));
    const done = await api(aliceRw, "/api/v1/asks/bulk", { action: "close", items: mine.slice(0, 1), preview: false });
    expect(done.status).toBe(201);
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(bob.id);
    try {
      const bobAdmin = createToken(app.db, bob.id, "rw", "rw").token;
      expect((await api(bobAdmin, `/api/v1/asks/bulk/${done.body.id}/undo`, {})).status).toBe(404);
      // Nor through the admin fleet route: rows picked one by one were alice's own choice.
      const fleetAdmin = createToken(app.db, bob.id, "admin", "admin").token;
      expect((await api(fleetAdmin, `/api/v1/fleet/ops/${done.body.id}/undo`, {})).status).toBe(404);
    } finally {
      app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(bob.id);
    }
    expect((await api(aliceRw, `/api/v1/asks/bulk/${done.body.id}/undo`, {})).status).toBe(201);
  });

  test("a read-only token previews over the MCP too", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${aliceRo}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "asks_act", arguments: { action: "dismiss", items: items(alice) } },
      }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBeUndefined();
    const acting = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${aliceRo}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "asks_act", arguments: { action: "dismiss", items: items(alice), dryRun: false } },
      }),
    });
    const refused = (await acting.json()) as { result: { isError?: boolean } };
    expect(refused.result.isError).toBe(true);
  });
  test("a held change does not ship in a batch: its row says who holds it, and the rest go", async () => {
    const made = await createUser(app.db, {
      trusted: true,
      username: "dana",
      email: "dana@forge.local",
      password: PASSWORD,
    });
    if (!made.ok) throw new Error(made.error);
    app.db
      .query("UPDATE user SET is_admin = 1 WHERE id = ?1")
      .run(made.value.id);
    const dana = getUserByName(app.db, "dana")!;
    const danaRw = createToken(app.db, dana.id, "rw", "rw").token;
    const held = await greenPull(quiet, "Not this one yet");
    const free = await greenPull(quiet, "This one goes");
    const why = "the security review is under way";
    expect(holdPull(app, alice, quiet, held, why).ok).toBe(true);
    // It asks nothing of alice, who holds it; it still asks dana for a look.
    expect(items(alice)).not.toContain(`look:${held.id}`);
    const picked = [`look:${held.id}`, `look:${free.id}`];
    for (const item of picked) expect(items(dana)).toContain(item);

    const rows = (body: any): Record<string, string> =>
      Object.fromEntries(
        body.rows.map(
          (r: { label: string; outcome: string; reason: string }) => [
            r.label,
            `${r.outcome} ${r.reason}`.trim(),
          ],
        ),
      );
    const now = (pull: Pull) => getPull(app.db, quiet.id, pull.number)!;
    const refusal = `refused held by alice (${why}): release it first`;
    const plan = await api(danaRw, "/api/v1/asks/bulk", {
      action: "ship",
      items: picked,
    });
    expect(plan.body.preview).toBe(true);
    expect(rows(plan.body)[`alice/quiet#${held.number}`]).toBe(refusal);
    const shipped = await api(danaRw, "/api/v1/asks/bulk", {
      action: "ship",
      items: picked,
      preview: false,
    });
    expect(shipped.status).toBe(201);
    expect(rows(shipped.body)).toEqual({
      [`alice/quiet#${held.number}`]: refusal,
      [`alice/quiet#${free.number}`]: "ok",
    });
    expect(now(free).mergedAt).not.toBeNull();
    expect([now(held).state, now(held).mergedAt]).toEqual(["open", null]);

    // Released, the same word ships it.
    expect(releasePull(app, alice, quiet, held).ok).toBe(true);
    const again = await api(danaRw, "/api/v1/asks/bulk", {
      action: "ship",
      items: [`look:${held.id}`],
      preview: false,
    });
    expect(rows(again.body)).toEqual({ [`alice/quiet#${held.number}`]: "ok" });
    expect(now(held).mergedAt).not.toBeNull();
  });
});
