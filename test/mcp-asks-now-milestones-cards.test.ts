/** MCP `asks`, `now` and `milestones` answer with their ui:// card beside the text: URI, title, rows, rooted links. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { newApp } from "../src/actions/apps.ts";
import { setAssignee } from "../src/core/issues.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CARD_URI, cardFor } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedMilestones } from "./fixtures/milestones-seed.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

describe("MCP asks, now and milestones cards", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return (await res.json()) as any;
  };
  const rooted = (origin: string, rows: { link?: string }[]) => {
    for (const r of rows) if (r.link !== undefined) expect(r.link.startsWith(`${origin}/`) && !r.link.startsWith(`${origin}//`)).toBe(true);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-three-cards-"));
    app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "ro", "ro").token;
    const made0 = await newApp(app, a.value, { name: "game", description: "x", visibility: "private" });
    if (!made0.ok) throw new Error(String(made0.error));
    const made = { value: made0.value.repo };
    const issue = openIssue(app, a.value, made.value, { title: "Sweep the path", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    setAssignee(app.db, issue.value.id, a.value.id);
    const run = createRun(app.db, { repoId: made.value.id, kind: "agent", issueId: issue.value.id, reason: "issue" });
    claimRun(app.db, run.id);
    const plan = await createRepo(app, a.value, { name: "plan", visibility: "private" });
    if (!plan.ok) throw new Error(String(plan.error));
    seedMilestones(app.db, plan.value.id, a.value.id, new Date());
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("asks: the decision card, a row per ask with a rooted link, and actions that carry the row's items", async () => {
    const body = await call("asks");
    const text = JSON.parse(body.result.content[0].text);
    const card = body.result.structuredContent.card;
    expect(CARD_URI(card.kind)).toBe("ui://forge/decision");
    expect(card.title).toBe("Waiting on you");
    expect(card.rows.length).toBe(text.rows.length);
    expect(card.rows.map((r: any) => r.label)).toEqual(text.rows.map((r: any) => r.line));
    expect(card.rows.some((r: any) => r.link === `${servers.url}/alice/game/issues/${text.rows.find((x: any) => x.numberOf === "issue")?.number}`)).toBe(true);
    rooted(servers.url, card.rows);
    const act = card.actions.filter((a: any) => a.tool === "asks_act");
    expect(act.map((a: any) => a.args.action)).toEqual(expect.arrayContaining(["close", "dismiss"]));
    for (const a of act) expect(a.args.items).toEqual(text.rows[0].items);
    // The tools/list entry names the card.
    const list = await listVia(async (p) => (await fetch(`${servers.url}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: p }) })).json());
    const by = (n: string) => list.result.tools.find((t: any) => t.name === n)?._meta?.ui?.resourceUri;
    expect(by("asks")).toBe("ui://forge/decision");
    expect(by("milestones")).toBe("ui://forge/milestones");
  });

  test("asks_act: a done action's receipt carries Undo with its operation; a plan has no card", () => {
    expect(cardFor("asks_act", { wouldDismiss: ["x"] }, "https://forge.test")).toBeUndefined();
    const done = cardFor("asks_act", { id: "op1", receipt: "Dismissed 2 asks", undoOf: null, undoneBy: null }, "https://forge.test")!;
    expect(done.rows).toEqual([{ label: "Receipt", value: "Dismissed 2 asks" }]);
    expect(done.actions).toEqual([{ label: "Undo", tool: "asks_act", args: { action: "undo", operation: "op1" } }]);
    const undone = cardFor("asks_act", { id: "op2", receipt: "Undid it", undoOf: "op1", undoneBy: null }, "")!;
    expect(undone.actions).toEqual([]);
  });

  test("now: the run card, who on what and since when, links rooted; a planner waiting on you is the first row", async () => {
    const body = await call("now");
    const text = JSON.parse(body.result.content[0].text);
    const card = body.result.structuredContent.card;
    expect(CARD_URI(card.kind)).toBe("ui://forge/run");
    expect(card.title).toBe("Working now");
    expect(card.rows.length).toBe(text.length);
    expect(card.rows[0].label).toBe("the crew on alice/game");
    expect(card.rows[0].value).toContain("Sweep the path");
    expect(card.rows[0].value).toContain("just now");
    expect(card.rows[0].link).toBe(`${servers.url}/alice/game/runs/${text[0].run}`);
    rooted(servers.url, card.rows);
    const waiting = cardFor("now", [
      { run: null, app: "alice/game", who: "the planner", on: "#3 Plan", state: "waiting for you", since: new Date().toISOString(), costUsd: 0 },
      { run: "0".repeat(26), app: "alice/game", who: "smith", on: null, state: "running", since: new Date().toISOString(), costUsd: 1.5 },
    ], "https://forge.test")!;
    expect(waiting.rows[0]!.label).toBe("the planner on alice/game");
    expect(waiting.rows[0]!.link).toBeUndefined();
    expect(waiting.rows[1]!.value).toContain("$1.50");
    expect(waiting.rows[1]!.value.startsWith(" —")).toBe(false);
  });

  test("milestones: the milestones card, done/total and a rooted link each; one milestone opened has no card", async () => {
    const body = await call("milestones", { app: "alice/plan" });
    const text = JSON.parse(body.result.content[0].text);
    const card = body.result.structuredContent.card;
    expect(CARD_URI(card.kind)).toBe("ui://forge/milestones");
    expect(card.title).toBe("Milestones");
    expect(card.rows.length).toBeGreaterThan(0);
    expect(card.rows[0].label).toBe(`#${text.limbs[0].number} ${text.limbs[0].name}`);
    expect(card.rows[0].value).toContain(`${text.limbs[0].done}/${text.limbs[0].total} done`);
    expect(card.rows[0].link).toBe(`${servers.url}/alice/plan/milestones/${text.limbs[0].number}`);
    rooted(servers.url, card.rows);
    const one = await call("milestones", { app: "alice/plan", issue: text.limbs[0].number });
    expect(one.result.structuredContent).toBeUndefined();
  });
});
