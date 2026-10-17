/**
 * The variant vote through MCP and the terminal: a reader is refused and
 * writes nothing; a writer's like is one ledger row; a dislike closes the
 * pull, leaves its reason as a comment and writes one `lean` row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listDecisions } from "../src/core/decisions.ts";
import { listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("variant votes over MCP and the terminal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceTok: string;
  let bobTok: string;
  let lib: Repo;
  let n = 0;

  const variant = async (variantGroup: string | null = "g") => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, lib, {
      branch,
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, lib, {
      title: `Try ${branch}`,
      baseBranch: "main",
      headBranch: branch,
      ...(variantGroup === null ? {} : { variantGroup }),
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const fresh = (num: number) => getPull(app.db, lib.id, num)!;
  const ledger = (id: string) =>
    listDecisions(app.db, lib.id, { kind: "lean" }).filter((r) => r.issueId === id);
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "variant", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  async function withTerminal(
    run: (press: (key: string) => Promise<void>, screen: () => string) => Promise<void>,
    number: number,
  ) {
    const terminal = headlessTerminal(140, 44);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:a", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, lib), number));
      const press = async (key: string) => {
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      };
      await settleApp(tui);
      await run(press, () => tui.screen.toText());
    } finally {
      tui.stop();
    }
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-vsurf-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const make = async (username: string, first: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await make("alice", true);
    bob = await make("bob", false);
    aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
    bobTok = createToken(app.db, bob.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seed = await commitToBranch(app, alice, lib, {
      message: "seed",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seed.ok) throw new Error(JSON.stringify(seed.error));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("MCP: a reader is refused and writes nothing", async () => {
    const pull = await variant();
    const refused = await mcp(bobTok, {
      repo: "alice/lib",
      number: pull.number,
      answer: "dislike",
      reason: "nope",
    });
    expect(refused.error).toBe(true);
    expect(ledger(pull.id)).toHaveLength(0);
    expect(fresh(pull.number).state).toBe("open");
  });

  test("MCP: a writer's dislike closes, comments the reason and writes one row; a bad answer is refused", async () => {
    const pull = await variant();
    expect((await mcp(aliceTok, { repo: "alice/lib", number: pull.number, answer: "meh" })).error).toBe(true);
    const done = await mcp(aliceTok, {
      repo: "alice/lib",
      number: pull.number,
      answer: "dislike",
      reason: "too loud",
    });
    expect(done.error).toBe(false);
    expect(fresh(pull.number).state).toBe("closed");
    expect(listComments(app.db, pull.id).some((c) => c.body.includes("too loud"))).toBe(true);
    const rows = ledger(pull.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.answer).toBe("dislike");
    // A second dislike of a closed pull adds nothing.
    await mcp(aliceTok, { repo: "alice/lib", number: pull.number, answer: "dislike" });
    expect(ledger(pull.id)).toHaveLength(1);
  });

  test("terminal: + likes a variant; the binding is absent on an ordinary pull", async () => {
    const pull = await variant();
    await withTerminal(async (press, screen) => {
      expect(screen()).toContain("like/dislike a variant");
      await press("+");
    }, pull.number);
    expect(ledger(pull.id).map((r) => r.answer)).toEqual(["like"]);
    expect(fresh(pull.number).state).toBe("open");
    const plain = await variant(null);
    await withTerminal(async (press, screen) => {
      expect(screen()).not.toContain("like/dislike a variant");
      await press("+");
    }, plain.number);
    expect(ledger(plain.id)).toHaveLength(0);
  }, 60_000);

  test("terminal: - asks for a reason and closes only on enter; esc cancels", async () => {
    const pull = await variant();
    await withTerminal(async (press) => {
      await press("-");
      await press("esc");
      expect(fresh(pull.number).state).toBe("open");
      expect(ledger(pull.id)).toHaveLength(0);
      await press("-");
      for (const ch of "too loud") await press(ch);
      await press("enter");
      await Bun.sleep(100);
    }, pull.number);
    expect(fresh(pull.number).state).toBe("closed");
    expect(listComments(app.db, pull.id).some((c) => c.body.includes("too loud"))).toBe(true);
    expect(ledger(pull.id).map((r) => r.answer)).toEqual(["dislike"]);
  }, 60_000);
});
