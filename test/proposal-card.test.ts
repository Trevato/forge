/**
 * A wave proposal is one inbox card (#1622): Approve opens its issues,
 * Redirect hands the owner's words to the planner, Later puts it aside.
 * Refusals come first: a non-owner and a cross-origin post change nothing.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { proposePlan } from "../src/actions/plan.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { listIssues, listComments } from "../src/core/issues.ts";
import { getProposal } from "../src/core/proposals.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-proposal-passphrase";

describe("a wave proposal is one inbox card", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceCookie = "";
  let bobCookie = "";
  let repo: Repo;

  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  const post = (cookie: string, path: string, fields: [string, string][] = [], origin = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie: `${cookie}; forge_mode=studio`, origin },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  const propose = (title: string): string => {
    const made = proposePlan(
      app,
      alice,
      repo,
      [
        { key: "a", title: "First <b>step</b>", body: "", blockedBy: [] },
        { key: "b", title: "Second step", body: "", blockedBy: ["a"] },
      ],
      { title, why: "because <script>x</script>" },
    );
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value.id;
  };

  const rows = () => askLinesFor(app.db, alice).filter((r) => r.proposal !== undefined);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: PASSWORD, adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: PASSWORD });
    if (!a.ok || !b.ok) throw new Error("users");
    alice = a.value;
    bob = b.value;
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    await createAgent(app, alice, { username: "planner" });
    const made = await createRepo(app, alice, { name: "wave", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# wave\n" }] });
    addToCrew(app, alice, repo, "planner");
    seatAs(app.db, repo.id, getAgentByName(app.db, "planner")!.user.id, "planner");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("refusals: a non-owner and a cross-origin post change nothing", async () => {
    const id = propose("Refused wave");
    expect((await post(bobCookie, `/asks/proposal/${id}/approve`)).status).toBe(403);
    expect((await post(aliceCookie, `/asks/proposal/${id}/approve`, [], "https://evil.example")).status).toBe(403);
    expect((await post("", `/asks/proposal/${id}/later`)).headers.get("location")).toContain("signin");
    expect(getProposal(app.db, id)!.state).toBe("pending");
    expect(listIssues(app.db, repo.id, { state: "open" }).length).toBe(0);
    expect(askLinesFor(app.db, bob).some((r) => r.proposal !== undefined)).toBe(false);
  });

  test("a pending proposal is one row with title, why and issue titles", async () => {
    const [row] = rows();
    expect(row!.proposal!.title).toBe("Refused wave");
    expect(row!.proposal!.issues).toEqual(["First <b>step</b>", "Second step"]);
    const page = await (await fetch(`${servers.url}/asks`, { headers: { cookie: `${aliceCookie}; forge_mode=studio` } })).text();
    expect(page).toContain("First &lt;b&gt;step&lt;/b&gt;");
    expect(page).toContain("because &lt;script&gt;");
    expect(page).not.toContain("<b>step</b>");
  });

  test("Later hides it; again brings it back", async () => {
    const id = rows()[0]!.proposal!.id;
    const res = await post(aliceCookie, `/asks/proposal/${id}/later`, [["back", "/asks"]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/asks");
    expect(rows()).toHaveLength(0);
    expect((await post(aliceCookie, `/asks/proposal/${id}/again`)).status).toBe(303);
    expect(rows()).toHaveLength(1);
  });

  test("Approve opens the issues with their links, once", async () => {
    const id = rows()[0]!.proposal!.id;
    const res = await post(aliceCookie, `/asks/proposal/${id}/approve`, [["back", "/asks"]]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/asks");
    const open = listIssues(app.db, repo.id, { state: "open" });
    expect(open.map((i) => i.title).sort()).toEqual(["First <b>step</b>", "Second step"]);
    expect(rows()).toHaveLength(0);
    await post(aliceCookie, `/asks/proposal/${id}/approve`);
    expect(listIssues(app.db, repo.id, { state: "open" })).toHaveLength(2);
  });

  test("Redirect writes the owner's words for the planner and takes the card off", async () => {
    const id = propose("Wrong wave");
    expect((await post(aliceCookie, `/asks/proposal/${id}/redirect`, [["words", "  "]])).status).toBe(200);
    expect(getProposal(app.db, id)!.state).toBe("pending");
    const res = await post(aliceCookie, `/asks/proposal/${id}/redirect`, [["words", "Do the tests first"], ["back", "/"]]);
    expect(res.status).toBe(303);
    expect(getProposal(app.db, id)!.state).toBe("redirected");
    const direction = listIssues(app.db, repo.id, { state: "open" }).find((i) => i.assigneeName === "planner");
    expect(direction).toBeDefined();
    expect(listComments(app.db, direction!.id).some((c) => c.body.includes("Do the tests first"))).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  test("home shows the Redirect box on the card, and Later's way back", async () => {
    const id = propose("Home wave");
    const get = async () =>
      (await (await fetch(`${servers.url}/asks`, { headers: { cookie: `${aliceCookie}; forge_mode=studio` } })).text());
    expect(await get()).toContain(`/asks/proposal/${id}/redirect`);
    await post(aliceCookie, `/asks/proposal/${id}/later`, [["back", "/"]]);
    const page = await get();
    expect(page).not.toContain(`/asks/proposal/${id}/redirect`);
    expect(page).toContain("1 wave put aside");
    expect(page).toContain(`/asks/proposal/${id}/again`);
    await post(aliceCookie, `/asks/proposal/${id}/again`);
    expect(getProposal(app.db, id)!.state).toBe("pending");
    await post(aliceCookie, `/asks/proposal/${id}/later`);
  });

  describe("the other doors", () => {
    let rw = "";
    let ro = "";
    let bobRw = "";
    beforeAll(() => {
      rw = createToken(app.db, alice.id, "rw", "rw").token;
      ro = createToken(app.db, alice.id, "ro", "ro").token;
      bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    });
    const api = async (token: string, id: string, verb: string, payload: unknown = {}) => {
      const res = await fetch(`${servers.url}/api/v1/asks/proposal/${id}/${verb}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const mcp = async (token: string, args: unknown, name = "asks_proposal") => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { error: body.result.isError === true, text: body.result.content[0].text as string };
    };

    test("API: refused to a reader, a read-only token and a stranger's verb; works for the owner", async () => {
      const id = propose("Api wave");
      expect((await api(bobRw, id, "approve")).status).toBe(403);
      expect((await api(ro, id, "later")).status).toBe(403);
      expect((await api(rw, id, "explode")).status).toBe(404);
      expect(getProposal(app.db, id)!.state).toBe("pending");
      expect((await api(rw, id, "redirect", { words: "" })).status).toBe(422);
      expect((await api(rw, id, "later")).status).toBe(201);
      expect(getProposal(app.db, id)!.state).toBe("later");
      expect((await api(rw, id, "later")).status).toBe(409);
      expect((await api(rw, id, "again")).status).toBe(201);
      const before = listIssues(app.db, repo.id, { state: "open" }).length;
      const done = await api(rw, id, "approve");
      expect(done.status).toBe(201);
      expect(done.body.opened).toHaveLength(2);
      expect(listIssues(app.db, repo.id, { state: "open" }).length).toBe(before + 2);
    });

    test("MCP: asks_proposal is a write that the owner alone may do", async () => {
      const id = propose("Mcp wave");
      expect((await mcp(ro, { id, verb: "later" })).error).toBe(true);
      expect((await mcp(bobRw, { id, verb: "later" })).error).toBe(true);
      expect((await mcp(rw, { id, verb: "bogus" })).error).toBe(true);
      expect((await mcp(rw, { id, verb: "later" })).error).toBe(false);
      expect(getProposal(app.db, id)!.state).toBe("later");
      expect((await mcp(rw, { id, verb: "again" })).error).toBe(false);
      const row = askLinesFor(app.db, alice).find((r) => r.proposal?.id === id);
      expect(row).toBeDefined();
      expect((await mcp(rw, { id, verb: "redirect", words: "Smaller, please" })).error).toBe(false);
      expect(getProposal(app.db, id)!.state).toBe("redirected");
    });

    test("MCP: the id /forge plan passes, the asks row's proposal.id, acts; the row id does not", async () => {
      const id = propose("Plan wave");
      const asks = await mcp(rw, {}, "asks");
      const row = JSON.parse(asks.text).rows?.find?.((r: any) => r.kind === "proposal" && r.proposal?.id === id);
      expect(row).toBeDefined();
      expect(row.id).toBe(`proposal:${id}`);
      expect((await mcp(rw, { id: row.id, verb: "later" })).error).toBe(true);
      expect((await mcp(rw, { id: row.proposal.id, verb: "later" })).error).toBe(false);
      expect(getProposal(app.db, id)!.state).toBe("later");
    });

    test("terminal: a wave is a row on the On you card; y approves, l puts aside, B brings back", async () => {
      const a = propose("Tui approve wave");
      const b = propose("Tui later wave");
      const terminal = headlessTerminal(140, 40);
      const { app: ui } = createForgeApp(
        app,
        { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
        { terminal, exitHooks: false },
      );
      ui.start();
      const press = async (key: string) => {
        ui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(ui);
      };
      await settleApp(ui);
      await press("tab");
      expect(ui.screen.toText()).toContain("Tui later wave");
      // The first row is wave a (oldest); y approves it.
      await press("y");
      expect(getProposal(app.db, a)!.state).toBe("approved");
      await press("l");
      expect(getProposal(app.db, b)!.state).toBe("later");
      expect(ui.screen.toText()).toContain("B brings it back");
      await press("B");
      expect(getProposal(app.db, b)!.state).toBe("pending");
      ui.stop();
    });
  });
});
