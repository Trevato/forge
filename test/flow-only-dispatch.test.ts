/**
 * FLOW ONLY stops builds, not just words: a builder starts only `flow`
 * issues while the switch is on, an assignment on any other waits and reads
 * "queued: flow only", and switching off dispatches it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue, setIssueLabels as labelIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getAgent } from "../src/core/agents.ts";
import { getLabel, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listActive } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { heldNow } from "../src/crew/held.ts";
import { flowOnlyQueued } from "../src/crew/flow_only.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { queuedText } from "../src/tui/screens/assign.ts";
import { queueAgentRun, sweepAssigned } from "../src/crew/dispatch.ts";

describe("flow only at the dispatcher", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let bot: User;
  let servers: Servers;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue => {
    const o = openIssue(app, alice, fresh(), { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const runsOn = (issue: Issue) =>
    listActive(app.db, "agent").filter((r) => r.issueId === issue.id).length;
  const assign = (issue: Issue): Issue => {
    const a = assignIssue(app, alice, fresh(), issue, bot);
    if (!a.ok) throw new Error(String(a.error));
    return a.value;
  };
  const flow = async (on: boolean) => {
    const set = await updateRepoSettings(app, alice, fresh(), { flowOnly: on });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-only-dispatch-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    servers = await serve(app);
    const made = await createRepo(app, alice, { name: "svc", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const created = await createAgent(app, alice, { username: "bot" });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    bot = getUserByName(app.db, "bot")!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a non-flow assignment waits while on, goes when off; a flow issue and a rebase run go on", async () => {
    await flow(true);
    const plain = assign(open("Plain"));
    sweepAssigned(app);
    expect(runsOn(plain)).toBe(0);
    expect(flowOnlyQueued(app.db, fresh(), plain)).toBe("queued: flow only");
    expect(heldNow(app, fresh()).by.flow_only.map((i) => i.id)).toContain(plain.id);

    const labelled = open("Labelled");
    const label = getLabel(app.db, repo.id, "flow")!;
    setIssueLabels(app.db, labelled.id, [label.id]);
    const flowing = assign(labelled);
    sweepAssigned(app);
    expect(runsOn(flowing)).toBe(1);
    expect(flowOnlyQueued(app.db, fresh(), flowing)).toBeNull();
    expect(heldNow(app, fresh()).by.flow_only.map((i) => i.id)).not.toContain(labelled.id);

    // A rebase run on the held issue is not a build.
    const agent = getAgent(app.db, bot.id)!;
    const other = open("Other");
    expect(queueAgentRun(app, fresh(), other, agent, "conflict")).toBeDefined();

    await flow(false);
    expect(runsOn(plain)).toBe(1);
    expect(flowOnlyQueued(app.db, fresh(), plain)).toBeNull();
  });

  test("the held state shows on the API, the terminal and the MCP, and the flow label dispatches it", async () => {
    await flow(true);
    const held = assign(open("Waits"));
    sweepAssigned(app);
    expect(queuedText(app.db, fresh(), held)).toBe(" · queued: flow only");

    const bearer = { authorization: `Bearer ${createToken(app.db, alice.id, "t", "admin").token}` };
    const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/svc/issues/${held.number}`, { headers: bearer })).json()) as any;
    expect(api.queued).toBe("queued: flow only");
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { ...bearer, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "issue", arguments: { repo: "alice/svc", number: held.number } },
      }),
    });
    expect(JSON.parse(((await res.json()) as any).result.content[0].text).queued).toBe("queued: flow only");

    const page = (await (await fetch(`${servers.url}/alice/svc/issues/${held.number}`, { headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` } })).text());
    expect(page).toContain('id="flow-only-queued"');

    // An assigned, never-run issue elsewhere waits for its own reasons; a label here must not start it.
    const made = await createRepo(app, alice, { name: "other", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, made.value, "bot").ok).toBe(true);
    const o = openIssue(app, alice, made.value, { title: "Elsewhere", body: "" });
    if (!o.ok) throw new Error(String(o.error));
    const elsewhere = assignIssue(app, alice, made.value, o.value, bot);
    expect(elsewhere.ok).toBe(true);

    // Labelling it `flow` lets it go now, with the switch still on.
    const labelled = labelIssue(app, alice, fresh(), held, ["flow"]);
    expect(labelled.ok).toBe(true);
    expect(runsOn(held)).toBe(1);
    expect(runsOn(o.value)).toBe(0);
    expect(queuedText(app.db, fresh(), held)).toBe("");
    const after = await (await fetch(`${servers.url}/alice/svc/issues/${held.number}`, { headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` } })).text();
    expect(after).not.toContain('id="flow-only-queued"');
  });
});
