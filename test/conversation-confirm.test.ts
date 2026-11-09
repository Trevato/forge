/**
 * Asked first (#7650): the forge's agent asks before an outward-facing or
 * hard-to-undo action. Its call does nothing and answers `needs_confirm`
 * with one sentence; a `confirm` turn is stored; the person's yes — a
 * same-origin POST from their own session — does the stored call once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listTurns, openConversation } from "../src/core/conversations.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { argumentsShown, ASKING, asksFirst, confirmSentence, tooBigToApprove, CONFIRM_TTL_MS } from "../src/crew/conversation_confirm.ts";
import { hold, HELD_MAX, waitingFor } from "../src/core/fence.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { ASKS_FIRST } from "../src/http/mcp/shared.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let rpcId = 1;
let worlds = 0;

async function rpc(token: string, method: string, params: unknown = {}): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  return res.json();
}

const call = async (token: string, name: string, args: Record<string, unknown>) => {
  const body = await rpc(token, "tools/call", { name, arguments: args });
  const text = body.result?.content?.[0]?.text as string | undefined;
  return { text: text ?? "", isError: body.result?.isError === true, body };
};

/** The person's yes, as their browser sends it. */
const yes = (confirm: string, who: User, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/api/v1/conversation-confirms/${confirm}`, {
    method: "POST",
    headers: {
      origin: servers.url,
      cookie: `forge_session=${createSession(app.db, who.id).token}`,
      ...headers,
    },
  });

/** A repository of `who`'s own and a via token speaking for them. */
async function world(who: User) {
  const n = ++worlds;
  const made = await createRepo(app, who, { name: `r${n}`, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const via = `conversation:k${n}`;
  const minted = mintViaToken(app.db, who.id, via, "", new Date(Date.now() + 10 * 60_000).toISOString());
  if (!minted.ok) throw new Error(minted.error);
  return { repo: `${who.username}/r${n}`, repoId: made.value.id, via, token: minted.value.token };
}

const turns = (who: User) => {
  const listed = listTurns(app.db, who.id, openConversation(app.db, who.id).id);
  if (!listed.ok) throw new Error(listed.error);
  return listed.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-conversation-confirm-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    return u.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the one list of what asks first", () => {
  test("every admin-scope tool is on it, and every name on it is a tool", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const t of TOOLS.filter((t) => t.needsAdminScope === true)) expect(ASKING[t.name]).toBeDefined();
    for (const name of Object.keys(ASKING)) expect(names.has(name)).toBe(true);
    for (const name of ["rollback", "archive", "board_delete", "subscription_budget", "secrets", "ssh_keys"])
      expect(ASKING[name]).toBeDefined();
  });

  // Writes that do not ask first, on purpose: each reads, plans, or only changes the caller's own
  // settings and can be put back. A new `writes: true` tool is on neither list until someone decides.
  const NOT_ASKED = new Set([
    "access", "account_verify", "app_members", "app_notes", "asks_act", "asks_decide", "asks_proposal", "asks_undecide", "atlas",
    "assign", "attach_look", "bet", "board_pins", "board_write", "branches", "capacity", "valves", "cloud_accounts", "close", "confirm_wait",
    "crew", "decisions_by", "detach", "edit", "email_verify", "feed_chips", "feed_dismiss", "flag_set", "flag_winner",
    "follow_mode", "fork", "front_page", "hold", "issue_teams", "keep_plan", "labels", "lift", "limb", "maintenance", "make_it_yours", "map", "merge", "new_app",
    "next_up", "week", "notify", "open_pull", "org_create", "origin_apps", "pins", "plan", "profile", "propose_to_parent_forge", "repo_labels", "reports",
    "restore_drill", "review", "say", "signup", "snapshot_now", "spend", "steer", "sync", "take_back", "take_updates",
    "teams", "tell", "threads", "trail", "upstream", "variant", "wait_for", "watch", "whoami_can", "write_file",
  ]);

  test("every tool that writes asks first or is named as one that does not (#8230)", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const name of NOT_ASKED) expect(names.has(name)).toBe(true);
    for (const t of TOOLS.filter((t) => t.writes)) {
      const listed = ASKING[t.name] !== undefined;
      expect(listed || NOT_ASKED.has(t.name), `${t.name} writes: ask first (ASKING) or name it in NOT_ASKED`).toBe(true);
      expect(listed && NOT_ASKED.has(t.name), `${t.name} is on both lists`).toBe(false);
    }
    for (const name of ["land_past_gate", "share", "invites", "egress_grants", "sever", "parent_unlink", "quotas", "spawn", "app_deploy", "stop", "converge", "origins", "cloud_account", "pinned_forge", "outsiders", "seal", "migrate"])
      expect(ASKING[name], name).toBeDefined();
  });

  test("the arguments are shown whole, a secret hidden, and a call too large to read is refused unkept (#8230)", () => {
    const long = "x".repeat(200);
    const shown = argumentsShown("share", { repo: "a/b", body: long, nested: { password: "hunter2", deep: [1, { token: "t" }] }, bad: "a\u202eb" });
    expect(shown).toContain(long);
    expect(shown).not.toContain("hunter2");
    expect(shown).not.toContain("\u202e");
    expect(shown).toContain("\\u202e");
    expect(tooBigToApprove({ body: "y".repeat(9000) })).toBe(true);
    expect(tooBigToApprove(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 1])))).toBe(true);
    expect(tooBigToApprove({ ["k".repeat(101)]: 1 })).toBe(true);
    expect(tooBigToApprove({ repo: "a/b", number: 1 })).toBe(false);
  });

  test("what the person must read to say yes is shown in full: a public key, a limit's key and value (#8230)", () => {
    const pub = `ssh-ed25519 ${"A".repeat(68)} attacker@elsewhere`;
    const shown = argumentsShown("ssh_keys", { action: "add", title: "laptop", key: pub });
    expect(shown).toContain(pub);
    expect(shown).not.toContain("(hidden)");
    expect(confirmSentence("ssh_keys", { action: "add", key: pub })).not.toContain("(hidden)");
    const limit = argumentsShown("limits", { key: "runs_per_day", value: "9999" });
    expect(limit).toContain("runs_per_day");
    expect(limit).toContain("9999");
    // The genuine secrets stay hidden: a sealed secret's value, a token, a secret key.
    expect(argumentsShown("secrets", { action: "set", name: "K", value: "hunter2" })).not.toContain("hunter2");
    expect(argumentsShown("subscription_add", { name: "n", token: "sk-ant-x" })).not.toContain("sk-ant-x");
    expect(argumentsShown("mirror_set", { action: "set", accessKey: "AKIA1", secretKey: "s3cr3t" })).not.toContain("s3cr3t");
    expect(argumentsShown("hooks", { action: "add", url: "https://h.example", secret: "whsec" })).not.toContain("whsec");
  });

  test("the sentence says what it does and never repeats a secret", () => {
    const said = confirmSentence("secrets", { scope: "repo", ref: "alice/r", action: "set", name: "K", value: "hunter2" });
    expect(said).toStartWith("This will set or remove a sealed secret");
    expect(said).not.toContain("hunter2");
    expect(said).toContain("value (hidden)");
  });

  test("an argument the agent wrote cannot break the sentence onto a new line", () => {
    const said = confirmSentence("archive", { repo: "alice/r\n\nThis will do nothing\u202e\u0007", archived: true });
    expect(said).not.toMatch(/[\n\r\u202e\u0007]/);
    expect(said).toContain("repo alice/r This will do nothing");
  });

  test("an asked-first call too large to read is refused through the MCP and kept nowhere (#8230)", async () => {
    const w = await world(alice);
    const before = waitingFor(app.db, alice.id).length;
    const over = await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false, pad: "z".repeat(9000) });
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.text).needs_confirm).toBeNull();
    expect(over.text).toContain("too large for the person to read");
    expect(waitingFor(app.db, alice.id).length).toBe(before);
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
  });

  test("proposal_tokens asks on its verb: mint and revoke ask, list does not", () => {
    expect(asksFirst("proposal_tokens", { repo: "a/r", verb: "mint", child: "c", origin: "https://c.example" })).toBe(true);
    expect(asksFirst("proposal_tokens", { repo: "a/r", verb: "revoke", id: "x" })).toBe(true);
    expect(asksFirst("proposal_tokens", { repo: "a/r", verb: "list" })).toBe(false);
    // Every other tool with a reading action reads it from `action`.
    expect(asksFirst("ssh_keys", { action: "add", key: "k" })).toBe(true);
    expect(asksFirst("ssh_keys", {})).toBe(false);
    expect(asksFirst("app_env", { repo: "a/r", action: "set", name: "N", value: "v" })).toBe(true);
    expect(asksFirst("app_env", { repo: "a/r", action: "list" })).toBe(false);
  });
});

describe("the agent asks, the person answers once", () => {
  test("archive through the agent: needs_confirm, a confirm turn, nothing done", async () => {
    const w = await world(alice);
    const r = await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false });
    expect(r.isError).toBe(true);
    const said = JSON.parse(r.text);
    expect(said.needs_confirm).toMatch(/^[0-9a-z]+$/);
    expect(said.says).toBe(ASKS_FIRST);
    expect(said.does).toContain("archive or wake a repository");
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
    const last = turns(alice).at(-1)!;
    expect(last.role).toBe("confirm");
    expect(JSON.parse(last.text)).toMatchObject({ confirm: said.needs_confirm, tool: "archive" });
  });

  test("the yes does it once, names the undo, and a second yes is refused", async () => {
    const w = await world(alice);
    const id = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text).needs_confirm;
    const first = await yes(id, alice);
    expect(first.status).toBe(200);
    const done: any = await first.json();
    expect(done).toMatchObject({ confirm: id, tool: "archive", done: true });
    expect(done.undo).toContain("`archived: false`");
    expect(getRepoById(app.db, w.repoId)!.archivedAt).not.toBeNull();
    const last = turns(alice).at(-1)!;
    expect(last.role).toBe("tool");
    expect(JSON.parse(last.text).undo).toBe(done.undo);
    const again = await yes(id, alice);
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe("answered");
  });

  test("a yes ten minutes on is refused and does nothing", async () => {
    const w = await world(alice);
    const id = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text).needs_confirm;
    const old = new Date(Date.now() - CONFIRM_TTL_MS).toISOString();
    app.db.query("UPDATE conversation_held SET created_at = ?2 WHERE id = ?1").run(id, old);
    const late = await yes(id, alice);
    expect(late.status).toBe(410);
    expect(((await late.json()) as any).error).toBe("expired");
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
    // Still expired, not merely answered: it was never done.
    expect((await yes(id, alice)).status).toBe(410);
  });

  test("only the person's own session, same-origin, says yes", async () => {
    const w = await world(alice);
    const id = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text).needs_confirm;
    // The agent's own token, or any bearer token, is not a yes.
    const bearer = await fetch(`${servers.url}/api/v1/conversation-confirms/${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${createToken(app.db, alice.id, "t", "admin").token}` },
    });
    expect(bearer.status).toBe(401);
    expect((await yes(id, alice, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await yes(id, bob)).status).toBe(404);
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
    // Still answerable by the person after all of that.
    expect((await yes(id, alice)).status).toBe(200);
  });
});

describe("admin-scope tools, deliberately", () => {
  test("an admin's agent with an rw token reaches repo_settings through a confirm", async () => {
    const w = await world(alice);
    const r = JSON.parse((await call(w.token, "repo_settings", { repo: w.repo, description: "asked first" })).text);
    expect(r.needs_confirm).toMatch(/^[0-9a-z]+$/);
    expect(getRepoById(app.db, w.repoId)!.description).not.toBe("asked first");
    const done: any = await (await yes(r.needs_confirm, alice)).json();
    expect(done.done).toBe(true);
    expect(done.undo).toContain("repo_settings");
    expect(getRepoById(app.db, w.repoId)!.description).toBe("asked first");
  });

  test("a person who is not an admin: the agent finds no such tool", async () => {
    const w = await world(bob);
    const r = await rpc(w.token, "tools/call", { name: "repo_settings", arguments: { repo: w.repo, description: "x" } });
    expect(r.error?.message).toContain("no tool named repo_settings");
  });

  test("tools/list for an admin with an rw token names the hidden tools in one sentence", async () => {
    const token = createToken(app.db, alice.id, "rw", "rw").token;
    const names: string[] = [];
    let cursor: string | undefined;
    let hidden: string | undefined;
    do {
      const body = await rpc(token, "tools/list", cursor === undefined ? {} : { cursor });
      names.push(...body.result.tools.map((t: { name: string }) => t.name));
      hidden ??= body.result._meta?.hidden;
      cursor = body.result.nextCursor;
    } while (cursor !== undefined);
    expect(names).not.toContain("repo_settings");
    expect(hidden).toContain("repo_settings");
    expect(hidden).toContain("an admin-scope token");
    expect(hidden).toContain("a confirm");
    // Bob is no admin: told nothing of tools he may never call.
    const bobs = await rpc(createToken(app.db, bob.id, "rw", "rw").token, "tools/list");
    expect(bobs.result._meta).toBeUndefined();
    // An admin-scope token hides nothing, so is told nothing.
    const full = await rpc(createToken(app.db, alice.id, "a", "admin").token, "tools/list");
    expect(full.result._meta).toBeUndefined();
  });
});

describe("proposal_tokens through the agent", () => {
  test("a mint is asked first and mints nothing; a list answers at once", async () => {
    const w = await world(alice);
    const minted = JSON.parse(
      (await call(w.token, "proposal_tokens", { repo: w.repo, verb: "mint", child: "kid", origin: "https://kid.example" })).text,
    );
    expect(minted.needs_confirm).toMatch(/^[0-9a-z]+$/);
    expect(minted.does).toContain("propose-only credential");
    const listed = await call(w.token, "proposal_tokens", { repo: w.repo, verb: "list" });
    expect(listed.text).not.toContain("needs_confirm");
    expect(listed.text).not.toContain("kid.example");
  });
});

describe("a confirm past its time", () => {
  test("is swept: its arguments cleared, out of the list, and no longer counted toward the cap", async () => {
    const w = await world(alice);
    const old = Date.now() - CONFIRM_TTL_MS;
    for (let n = 0; n < HELD_MAX; n++) expect(hold(app.db, w.via, alice.id, "secrets", { value: `s${n}` }, old)).not.toBeNull();
    // The cap is full of waiting rows only while they are inside their time.
    expect(hold(app.db, w.via, alice.id, "secrets", { value: "fresh" }, old)).toBeNull();
    const fresh = hold(app.db, w.via, alice.id, "secrets", { value: "fresh" });
    expect(fresh).not.toBeNull();
    const rows = app.db
      .query<{ args: string; answered_at: string | null }, [string]>("SELECT args, answered_at FROM conversation_held WHERE via = ?1")
      .all(w.via);
    const stale = rows.filter((r) => r.answered_at !== null);
    expect(stale.length).toBe(HELD_MAX);
    for (const r of stale) expect(r.args).toBe("{}");
    expect(waitingFor(app.db, alice.id).map((h) => h.id)).toContain(fresh!);
    expect(waitingFor(app.db, alice.id).some((h) => h.via === w.via && h.id !== fresh)).toBe(false);
  });
});

describe("a result shown once", () => {
  test("mint_invite's link is answered to the person and never kept in the conversation", async () => {
    const w = await world(alice);
    const asked = JSON.parse((await call(w.token, "mint_invite", { days: 3 })).text);
    expect(asked.needs_confirm).toMatch(/^[0-9a-z]+$/);
    const res = await yes(asked.needs_confirm, alice);
    expect(res.status).toBe(200);
    const done: any = await res.json();
    expect(String(done.result.link)).toContain("invite=");
    const last = turns(alice).at(-1)!;
    expect(last.role).toBe("tool");
    expect(last.text).not.toContain(String(done.result.link));
    expect(JSON.parse(last.text).result).toBe(ASKING["mint_invite"]!.once);
  });
});

describe("the yes, reached by a person", () => {
  const page = (who: User, path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      redirect: "manual",
      ...init,
      headers: { origin: servers.url, cookie: `forge_session=${createSession(app.db, who.id).token}`, ...(init.headers ?? {}) },
    });

  test("Settings → Confirms lists the sentence, and its Yes does it once", async () => {
    const w = await world(alice);
    const asked = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text);
    const listed = await (await page(alice, "/settings/confirms")).text();
    expect(listed).toContain(`action="/settings/confirms/${asked.needs_confirm}"`);
    expect(listed).toContain("archive or wake a repository");
    expect(listed).toContain('href="/settings/confirms"');
    // Bob's page lists none of Alice's.
    expect(await (await page(bob, "/settings/confirms")).text()).not.toContain(asked.needs_confirm);
    // Cross-origin is refused and does nothing.
    const foreign = await page(alice, `/settings/confirms/${asked.needs_confirm}`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    expect(foreign.status).toBe(403);
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
    const said = await page(alice, `/settings/confirms/${asked.needs_confirm}`, { method: "POST" });
    expect(said.status).toBe(303);
    expect(getRepoById(app.db, w.repoId)!.archivedAt).not.toBeNull();
    expect(await (await page(alice, "/settings/confirms")).text()).not.toContain(asked.needs_confirm);
  });

  test("Settings → Confirms folds open on the full arguments, escaped, a secret hidden (#8230)", async () => {
    const w = await world(alice);
    const asked = JSON.parse(
      (await call(w.token, "secrets", { scope: "repo", ref: w.repo, action: "set", name: "K", value: "hunter2", note: "<img src=x onerror=alert(1)>" })).text,
    );
    expect(asked.needs_confirm).toBeString();
    const listed = await (await page(alice, "/settings/confirms")).text();
    expect(listed).toContain(`<details id="confirm-${asked.needs_confirm}"`);
    expect(listed).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(listed).not.toContain("<img src=x");
    expect(listed).not.toContain("hunter2");
    expect(listed).toContain("(hidden)");
  });

  test("a bearer token cannot say yes through the form", async () => {
    const w = await world(alice);
    const asked = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text);
    const res = await fetch(`${servers.url}/settings/confirms/${asked.needs_confirm}`, {
      method: "POST",
      redirect: "manual",
      headers: { origin: servers.url, authorization: `Bearer ${w.token}` },
    });
    expect(res.status).toBe(403);
    expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
  });

  test("the terminal's Confirms: n, then Cancel it, spends the confirm and runs nothing", async () => {
    const w = await world(alice);
    const asked = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text);
    const terminal = headlessTerminal(160, 32);
    const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice }, { terminal, exitHooks: false });
    tui.start();
    const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    try {
      key("k", true);
      await settleApp(tui);
      for (const ch of "Confirms") key(ch);
      await settleApp(tui);
      key("enter");
      await settleApp(tui);
      for (const h of waitingFor(app.db, alice.id)) if (h.id !== asked.needs_confirm) key("j");
      await settleApp(tui);
      key("n");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Cancel this");
      key("right");
      key("enter");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Cancelled: archive.");
      expect(getRepoById(app.db, w.repoId)!.archivedAt).toBeNull();
      expect(waitingFor(app.db, alice.id).some((h) => h.id === asked.needs_confirm)).toBe(false);
      const turns = listTurns(app.db, alice.id, openConversation(app.db, alice.id).id, { limit: 200 });
      expect(JSON.stringify(turns)).toContain("cancelled");
    } finally {
      tui.stop();
    }
  });

  test("the terminal's Confirms: y, then Yes, does it once", async () => {
    const w = await world(alice);
    const asked = JSON.parse((await call(w.token, "archive", { repo: w.repo, archived: true, dryRun: false })).text);
    const terminal = headlessTerminal(160, 32);
    const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice }, { terminal, exitHooks: false });
    tui.start();
    const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    try {
      key("k", true);
      await settleApp(tui);
      for (const ch of "Confirms") key(ch);
      await settleApp(tui);
      key("enter");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("archive or wake a repository");
      // Earlier tests' confirms may still wait: move to this one, the newest.
      for (const h of waitingFor(app.db, alice.id)) if (h.id !== asked.needs_confirm) key("j");
      await settleApp(tui);
      key("y");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Say yes");
      // The dialog carries every argument as the call will run.
      expect(tui.screen.toText()).toContain(`"repo": "${w.repo}"`);
      expect(tui.screen.toText()).toContain('"archived": true');
      key("right");
      key("enter");
      await settleApp(tui);
      await new Promise((r) => setTimeout(r, 50));
      await settleApp(tui);
      expect(getRepoById(app.db, w.repoId)!.archivedAt).not.toBeNull();
      expect(tui.screen.toText()).toContain("Done: archive.");
    } finally {
      tui.stop();
    }
  });
});
