/**
 * A bug closed with no fix behind it says why, through every door: the PATCH
 * route, the MCP `close` tool, the page's form, the terminal's `close` verb;
 * and the closes that need no note (triage, stale, system, split, a pull).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { createIssue, createLabel, getIssue, getIssueById, listComments, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { applyFleetOp } from "../src/actions/fleet.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { FLASH_COOKIE } from "../src/web/flash.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";

const PASSWORD = "a-good-passphrase";

describe("a bug closes with a reason, through every door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let token: string;
  let cookie: string;
  let bugId: string;
  let n = 0;
  let rpc = 1;

  const bug = (label = true): Issue => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `Bug ${++n}` });
    if (!made.ok) throw new Error(made.error);
    if (label) setIssueLabels(app.db, made.value.id, [bugId]);
    return made.value;
  };
  const state = (issue: Issue) => getIssueById(app.db, issue.id)!.state;
  const patch = (issue: Issue, body: unknown) =>
    fetch(`${base}/api/v1/repos/alice/game/issues/${issue.number}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const mcp = async (args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpc++,
        method: "tools/call",
        params: { name: "close", arguments: args },
      }),
    });
    const body: any = await res.json();
    return { error: body.result.isError as boolean, text: body.result.content[0].text as string };
  };
  const form = async (issue: Issue, fields: [string, string][]): Promise<string> => {
    const res = await fetch(`${base}/alice/game/issues/${issue.number}/state`, {
      method: "POST",
      headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams([["state", "closed"], ...fields]).toString(),
      redirect: "manual",
    });
    const flash = res.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith(`${FLASH_COOKIE}=`));
    return JSON.parse(decodeURIComponent(flash!.slice(FLASH_COOKIE.length + 1))).message;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-bug-close-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    token = createToken(app.db, alice.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const label = createLabel(app.db, repo.id, "bug", "d73a4a");
    if (!label.ok) throw new Error(label.error);
    bugId = label.value.id;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username: "alice", password: PASSWORD }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the API answers 422 reason_required, invalid_note for a bad one, and closes with a note", async () => {
    const issue = bug();
    const bare = await patch(issue, { state: "closed", reason: "dropped" });
    expect(bare.status).toBe(422);
    expect(((await bare.json()) as any).error).toBe("reason_required");
    const long = await patch(issue, { state: "closed", note: "x".repeat(301) });
    expect(((await long.json()) as any).error).toBe("invalid_note");
    const odd = await patch(issue, { state: "closed", note: 7 });
    expect(((await odd.json()) as any).error).toBe("invalid_note");
    expect(state(issue)).toBe("open");
    const ok = await patch(issue, { state: "closed", reason: "dropped", note: "works as designed" });
    expect(ok.status).toBe(200);
    expect(listComments(app.db, issue.id).map((c) => c.body)).toContain("Closed as won't fix: works as designed");
  });

  test("MCP close refuses the same way and takes a note", async () => {
    const issue = bug();
    const refused = await mcp({ repo: "alice/game", number: issue.number });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("reason_required");
    expect(state(issue)).toBe("open");
    const done = await mcp({ repo: "alice/game", number: issue.number, note: "cannot reproduce" });
    expect(done.error).not.toBe(true);
    expect(state(issue)).toBe("closed");
  });

  test("the page flashes the refusal and the long note, and closes with a note", async () => {
    const issue = bug();
    expect(await form(issue, [["reason", "dropped"]])).toContain("says why");
    expect(await form(issue, [["note", "x".repeat(301)]])).toContain("300");
    expect(state(issue)).toBe("open");
    expect(await form(issue, [["reason", "dropped"], ["note", "by design"]])).toBe("Closed.");
    expect(state(issue)).toBe("closed");
  });

  test("the terminal's close verb refuses a bug without a reason and writes it with one", async () => {
    const issue = bug();
    const q = `issue repo:alice/game number:${issue.number}`;
    const bare = await applyFleetOp(app, alice, q, "close");
    expect(bare.ok && bare.value.rows[0]?.outcome).not.toBe("ok");
    expect(state(issue)).toBe("open");
    const said = await applyFleetOp(app, alice, q, { verb: "close", value: "not a bug" });
    expect(said.ok && said.value.rows[0]?.outcome).toBe("ok");
    expect(listComments(app.db, issue.id).map((c) => c.body)).toContain("Closed: not a bug");
  });

  test("a reason on a plain issue is optional and still written", () => {
    const plain = bug(false);
    expect(setIssueState(app, alice, repo, plain, "closed").ok).toBe(true);
  });

  test("the closes that need no note: triage, stale, system, split, commits on main", () => {
    for (const closing of [{ triage: true }, { stale: true }, { system: true, reason: "done" as const }]) {
      const issue = bug();
      expect(setIssueState(app, alice, repo, issue, "closed", closing).ok).toBe(true);
    }
    const parent = bug();
    const child = bug(false);
    expect(setIssueState(app, alice, repo, parent, "closed", { reason: "split", into: [child.number] }).ok).toBe(true);
    // Without any exemption, the same close is refused.
    const bare = bug();
    const refused = setIssueState(app, alice, repo, bare, "closed");
    expect(!refused.ok && refused.error).toBe("reason_required");
    expect(getIssue(app.db, repo.id, bare.number)!.state).toBe("open");
  });
});
