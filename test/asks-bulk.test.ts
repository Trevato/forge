/**
 * Bulk asks (#690): select many, preview, act once, undo — by page, API and
 * MCP — as a fleet operation, so every row is checked against the actor's
 * own access and a refused row never stops the others. The refusals come
 * first: an outsider and a plain reader act on nothing.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { holdPull, releasePull } from "../src/actions/holds.ts";
import { setHold } from "../src/core/holds.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { mutedRepos, recordInteraction, removeMutes } from "../src/core/interactions.ts";
import { needsYouSection } from "../src/web/studio/asks_page.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { VERBS, type Target } from "../src/fleet/verbs.ts";
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
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
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
      seatAs(
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
    expect((preview.match(/form="asks-bulk" data-repo="[^"]*" data-kind="[^"]*" checked/g) ?? []).length).toBe(picked.length);
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
      origin: "seed",
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
  test("a hold set after the plan and before the write still holds: the write asks again", async () => {
    // The row's plan found nothing to refuse; by the time its write runs,
    // earlier rows of the batch have landed and a person has held this one.
    const dana = getUserByName(app.db, "dana")!;
    const pull = await greenPull(quiet, "Held between plan and write");
    const target: Target = {
      id: pull.id,
      repo: quiet,
      label: `alice/quiet#${pull.number}`,
      issue: getIssueById(app.db, pull.id)!,
      merged: false,
      green: true,
      stale: false,
    };
    const ship = VERBS["ship"]!;
    expect(ship.refuse(app, target, "shipped")).toBeUndefined();
    setHold(app.db, pull.id, alice.id, "wait for the migration");
    expect(await ship.write(app, dana, target, "shipped")).toBe(
      "held by alice (wait for the migration): release it first",
    );
    expect(getPull(app.db, quiet.id, pull.number)!.mergedAt).toBeNull();
  });

  test("decline is dismiss under the asks' own word, and undoes the same", async () => {
    const pull = await greenPull(open, "Decline me");
    const ask = items(alice).filter((i) => i.endsWith(pull.id));
    expect(ask).toHaveLength(1);
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "decline",
      items: ask,
      preview: false,
    });
    expect(done.status).toBe(201);
    expect(done.body.verb).toBe("dismiss");
    expect(items(alice).filter((i) => i.endsWith(pull.id))).toHaveLength(0);
    const undone = await api(aliceRw, `/api/v1/asks/bulk/${done.body.id}/undo`, {});
    expect(undone.status).toBe(201);
    expect(items(alice).filter((i) => i.endsWith(pull.id))).toHaveLength(1);
  });

  test("close many with one reason, written on each; undo opens them again", async () => {
    const a = await greenPull(open, "Close one");
    const b = await greenPull(quiet, "Close two");
    const ask = items(alice).filter((i) => i.endsWith(a.id) || i.endsWith(b.id));
    expect(ask).toHaveLength(2);
    // A reason belongs to close alone, and is a sentence.
    const odd = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "dismiss",
      items: ask,
      reason: "nope",
      preview: false,
    });
    expect(odd.status).toBe(422);
    const long = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "close",
      items: ask,
      reason: "x".repeat(301),
      preview: false,
    });
    expect(long.status).toBe(422);
    expect(getIssueById(app.db, a.id)!.state).toBe("open");
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "close",
      items: ask,
      reason: "the week moved on",
      preview: false,
    });
    expect(done.status).toBe(201);
    expect(done.body.rows.map((r: { outcome: string }) => r.outcome)).toEqual(["ok", "ok"]);
    for (const pull of [a, b]) {
      expect(getIssueById(app.db, pull.id)!.state).toBe("closed");
      const said = listComments(app.db, pull.id).map((c) => c.body);
      expect(said).toContain("Closed: the week moved on");
    }
    const undone = await api(aliceRw, `/api/v1/asks/bulk/${done.body.id}/undo`, {});
    expect(undone.status).toBe(201);
    for (const pull of [a, b]) expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });

  test("mute silences a repository in On you, for the person alone; undo listens again", async () => {
    const a = await greenPull(open, "On you one");
    const b = await greenPull(open, "On you two");
    for (const pull of [a, b]) {
      const issue = getIssueById(app.db, pull.id)!;
      expect(assignIssue(app, alice, open, issue, alice).ok).toBe(true);
    }
    const ctx = (user: User) => ({ app, auth: { user }, url: new URL("http://x/") }) as never;
    const card = (user: User) => needsYouSection(ctx(user), user).body.text;
    expect(card(alice)).toContain("On you one");
    // The list offers the set: a box each, the kinds, one form.
    expect(card(alice)).toContain('form="asks-bulk"');
    // A green pull assigned to alice is an ask: one row, under the ask's id.
    expect(card(alice)).toContain('value="look:' + a.id + '"');
    expect(card(alice)).not.toContain('value="assigned:' + a.id + '"');
    expect(card(alice)).toContain("data-pick");
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "mute",
      items: [`issue:${a.id}`, `issue:${b.id}`],
      preview: false,
    });
    expect(done.status).toBe(201);
    expect(mutedRepos(app.db, alice.id).has(open.id)).toBe(true);
    expect(mutedRepos(app.db, bob.id).has(open.id)).toBe(false);
    expect(card(alice)).not.toContain("On you one");
    const undone = await api(aliceRw, `/api/v1/asks/bulk/${done.body.id}/undo`, {});
    expect(undone.status).toBe(201);
    expect(mutedRepos(app.db, alice.id).has(open.id)).toBe(false);
    expect(card(alice)).toContain("On you one");
    // Only what is assigned to the viewer is theirs to name this way.
    const other = await api(bobRw, "/api/v1/asks/bulk", {
      action: "mute",
      items: [`issue:${a.id}`],
      preview: false,
    });
    expect(other.body.rows).toHaveLength(0);
    expect(other.body.skipped).toHaveLength(1);
  });

  test("the card's one request answers its script with the region and the count; one undo link stays for a day", async () => {
    const a = await greenPull(open, "Card one");
    const b = await greenPull(open, "Card two");
    for (const pull of [a, b])
      expect(assignIssue(app, alice, open, getIssueById(app.db, pull.id)!, alice).ok).toBe(true);
    const headers = { cookie: `${aliceCookie}; forge_mode=studio`, origin: servers.url, "x-forge-fragment": "1" };
    const res = await fetch(`${servers.url}/asks/bulk`, {
      method: "POST",
      headers,
      body: new URLSearchParams([
        ["action", "close"],
        ["reason", "not this week"],
        ["apply", "1"],
        ["item", `issue:${a.id}`],
        ["item", `issue:${b.id}`],
      ]),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="live-on-you"');
    expect(text).not.toContain("Card one");
    expect(getIssueById(app.db, a.id)!.state).toBe("closed");
    // The undo link rides on the card, and is the same one after a refresh.
    const again = await fetch(`${servers.url}/live/on-you`, { headers }).then((r) => r.text());
    const undo = /action="(\/asks\/bulk\/[^"]+\/undo)"/.exec(again)?.[1];
    expect(undo).toBeDefined();
    const id = undo!.split("/")[3]!;
    // A day later the link is gone and the undo is refused.
    app.db.query("UPDATE fleet_operation SET created_at = ?1 WHERE id = ?2").run(
      new Date(Date.now() - 86_400_000 - 60_000).toISOString(),
      id,
    );
    const late = await fetch(`${servers.url}/live/on-you`, { headers }).then((r) => r.text());
    expect(late).not.toContain("/undo");
    const refused = await api(aliceRw, `/api/v1/asks/bulk/${id}/undo`, {});
    expect(refused.status).toBe(409);
    expect(getIssueById(app.db, a.id)!.state).toBe("closed");
    // The same day on the other doors: the fleet route refuses too.
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    const fleet = await api(admin, `/api/v1/fleet/ops/${id}/undo`, {});
    expect(fleet.status).toBe(409);
    expect(getIssueById(app.db, a.id)!.state).toBe("closed");
  });

  test("a muted repository is named on the card, and one request listens again", async () => {
    const a = await greenPull(open, "Muted one");
    const b = await greenPull(open, "Muted two");
    for (const pull of [a, b])
      expect(assignIssue(app, alice, open, getIssueById(app.db, pull.id)!, alice).ok).toBe(true);
    const card = () =>
      needsYouSection({ app, auth: { user: alice }, url: new URL("http://x/") } as never, alice).body.text;
    expect(card()).not.toContain("muted repositor");
    const done = await api(aliceRw, "/api/v1/asks/bulk", {
      action: "mute",
      items: [`issue:${a.id}`, `issue:${b.id}`],
      preview: false,
    });
    expect(done.status).toBe(201);
    // Past the day's undo, the card still says it, and offers the way back.
    expect(card()).toContain("1 muted repository still asks");
    expect(card()).toContain('action="/asks/listen"');
    const headers = { cookie: `${aliceCookie}; forge_mode=studio`, origin: servers.url };
    const res = await fetch(`${servers.url}/asks/listen`, {
      method: "POST",
      headers,
      body: new URLSearchParams([["repo", open.id]]),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(mutedRepos(app.db, alice.id).has(open.id)).toBe(false);
    expect(card()).toContain("Muted one");
    expect(card()).not.toContain("muted repository still asks");
  });
  test("on the card, a refusal answers 422 with its message, and a partial set says what was not done", async () => {
    const a = await greenPull(open, "Refuse one");
    expect(assignIssue(app, alice, open, getIssueById(app.db, a.id)!, bob).ok).toBe(true);
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "bob", password: PASSWORD }),
      redirect: "manual",
    });
    const bobCookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const post = (cookie: string, action: string, reason: string, item: string) =>
      fetch(`${servers.url}/asks/bulk`, {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: servers.url, "x-forge-fragment": "1" },
        body: new URLSearchParams([["action", action], ["reason", reason], ["apply", "1"], ["item", item]]),
      });
    // A reason belongs to close alone: the script gets an error, not a page.
    const odd = await post(aliceCookie, "mute", "because", `issue:${a.id}`);
    expect(odd.status).toBe(422);
    expect(await odd.text()).toContain("reason");
    // Bob cannot close it: nothing changes, and the card says why.
    const res = await post(bobCookie, "close", "", `issue:${a.id}`);
    const text = res.status === 200 ? await res.text() : "";
    expect(res.status === 422 || /not done/.test(text)).toBe(true);
    expect(getIssueById(app.db, a.id)!.state).toBe("open");
  });

  test("undoing a bulk mute leaves a mute made elsewhere", () => {
    const item = `repo:${quiet.id}`;
    recordInteraction(app.db, { viewerId: alice.id, itemId: item, kind: "muted", repoId: quiet.id, actorId: null });
    recordInteraction(app.db, { viewerId: alice.id, itemId: "event:x", kind: "muted", repoId: quiet.id, actorId: null });
    removeMutes(app.db, alice.id, [item]);
    expect(mutedRepos(app.db, alice.id).has(quiet.id)).toBe(true);
    removeMutes(app.db, alice.id, ["event:x"]);
    expect(mutedRepos(app.db, alice.id).has(quiet.id)).toBe(false);
  });
});
