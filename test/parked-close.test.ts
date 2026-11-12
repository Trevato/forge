/**
 * A pull the crew parked closes as parked, not done (#1624). Only the crew
 * may say so: the API and the thread page refuse the word, a parked pull
 * stores no close_reason a raw query could read as done, and a reopen
 * clears it. Both doors name it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a parked pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let headers: Record<string, string>;
  let count = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-parked-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
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
    const made = await createRepo(app, alice, {
      name: "shop",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# shop\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    headers = {
      authorization: `Bearer ${createToken(app.db, alice.id, "t", "rw").token}`,
      "content-type": "application/json",
    };
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const makePull = async (): Promise<Issue> => {
    const name = `feature/p${++count}`;
    const branch = await commitToBranch(app, alice, repo, {
      branch: name,
      base: "main",
      message: name,
      files: [
        { path: `${name.slice(8)}.ts`, content: "export const x = 1;\n" },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: `Pull ${count}`,
      baseBranch: "main",
      headBranch: name,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return getIssueById(app.db, opened.value.id)!;
  };

  const rawReason = (id: string) =>
    app.db
      .query<{ close_reason: string | null }, [string]>(
        "SELECT close_reason FROM issue WHERE id = ?1",
      )
      .get(id)!.close_reason;

  test("closes as parked and leaves no 'done' for raw SQL to find", async () => {
    const pull = await makePull();
    const closed = setIssueState(app, alice, repo, pull, "closed", {
      reason: "parked",
    });
    expect(closed.ok).toBe(true);
    expect(getIssueById(app.db, pull.id)!.closeReason).toBe("parked");
    expect(rawReason(pull.id)).toBeNull();
  });

  test("reopening clears it", async () => {
    const pull = await makePull();
    setIssueState(app, alice, repo, pull, "closed", { reason: "parked" });
    const reopened = setIssueState(
      app,
      alice,
      repo,
      getIssueById(app.db, pull.id)!,
      "open",
    );
    expect(reopened.ok).toBe(true);
    const after = getIssueById(app.db, pull.id)!;
    expect(after.state).toBe("open");
    expect(after.closeReason).toBeNull();
    const parked = app.db
      .query<{ parked: number }, [string]>(
        "SELECT parked FROM issue WHERE id = ?1",
      )
      .get(pull.id)!.parked;
    expect(parked).toBe(0);
  });

  test("an issue cannot be parked, and a parked pull takes no children", async () => {
    const made = openIssue(app, alice, repo, { title: "Plain", body: "" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = made.value;
    const asIssue = setIssueState(app, alice, repo, issue, "closed", {
      reason: "parked",
    });
    expect(asIssue.ok).toBe(false);
    if (!asIssue.ok) expect(asIssue.error).toBe("invalid_reason");
    const pull = await makePull();
    const into = setIssueState(app, alice, repo, pull, "closed", {
      reason: "parked",
      into: [issue.number],
    });
    expect(into.ok).toBe(false);
    if (!into.ok) expect(into.error).toBe("invalid_reason");
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
  });

  test("the API and the thread page refuse the word", async () => {
    const pull = await makePull();
    const res = await fetch(
      `${servers.url}/api/v1/repos/alice/shop/pulls/${pull.number}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: "closed", reason: "parked" }),
      },
    );
    expect(res.status).toBe(422);
    expect(getIssueById(app.db, pull.id)!.state).toBe("open");
    const { CLOSE_REASONS } = await import("../src/core/issues.ts");
    expect(CLOSE_REASONS).not.toContain("parked");
  });

  test("the pull page and the pulls list say parked, and an ordinary close still says closed", async () => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const get = async (path: string) =>
      (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
    const parked = await makePull();
    setIssueState(app, alice, repo, parked, "closed", { reason: "parked" });
    const plain = await makePull();
    setIssueState(app, alice, repo, plain, "closed");

    const page = await get(`/alice/shop/pulls/${parked.number}`);
    expect(page).toMatch(/data-state="closed"[\s\S]*?"word-text">Parked</);
    expect(page).not.toMatch(/"word-text">Closed</);
    expect(await get(`/alice/shop/pulls/${plain.number}`)).toMatch(
      /"word-text">Closed</,
    );

    const list = await get("/alice/shop/pulls?word=stopped");
    expect(list).toContain("parked by the crew");
    expect(list).toContain("closed without shipping");
  });

  test("the terminal's merge box says parked", async () => {
    const pull = await makePull();
    setIssueState(app, alice, repo, pull, "closed", { reason: "parked" });
    const terminal = headlessTerminal(140, 44);
    const { app: tui, session } = createForgeApp(
      app,
      {
        sshUsername: "alice",
        remoteAddress: "127.0.0.1",
        fingerprint: "SHA256:alice",
        user: alice,
      },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(
        pullScreen(session, tui.ctx, local(session, repo), pull.number),
      );
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("Parked by the crew, not merged")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      expect(tui.screen.toText()).not.toContain("Closed without merging");
    } finally {
      tui.stop();
    }
  }, 60_000);
});
