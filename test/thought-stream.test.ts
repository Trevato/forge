/** The thought stream on /asked (#653): states derive, flag after N days, superseded shown. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { savePlacement, type Placed } from "../src/core/placements.ts";
import type { Repo } from "../src/core/repos.ts";
import { setUserSetting } from "../src/core/settings.ts";
import { flagDays, streamJson, thoughtStream } from "../src/core/thought_stream.ts";
import { serve } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();
const DAY = 24 * 60 * 60 * 1000;

describe("thought stream", () => {
  let dir = "";
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "thoughts-"));
    app = createApp({ dataDir: dir, port: 0 });
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      promote(app.db, u.value);
      return u.value;
    };
    // The first account is the forge's admin, who reads everything: not the viewer.
    bob = await mk("bob", true);
    alice = await mk("alice");
    const made = await createRepo(app, alice, { name: "game" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# game\n" }] });
  });
  afterAll(async () => {
    app.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  const issue = () => {
    const made = openIssue(app, alice, repo, { title: `work ${++n}` });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const thought = (text: string, ago: number, who = alice) => {
    const id = `t${++n}`;
    app.db
      .query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'composer', ?4)")
      .run(id, who.id, text, new Date(Date.now() - ago * DAY).toISOString());
    return id;
  };
  const place = (id: string, placed: Placed[], ago: number) =>
    savePlacement(app.db, {
      thoughtId: id, kind: "work", placed, reply: "ok", asked: false, decidedBy: "rule",
      placedAt: new Date(Date.now() - ago * DAY).toISOString(),
    });
  const slug = "alice/game";
  const find = (id: string) => thoughtStream(app.db, alice).find((t) => t.id === id)!;

  test("newest first, verbatim, yours only; unplaced until placed", () => {
    const a = thought("  first, as typed\n", 0.2);
    const b = thought("second", 0.1);
    thought("bob's", 0.1, bob);
    const ids = thoughtStream(app.db, alice).map((t) => t.id);
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
    expect(find(a).text).toBe("  first, as typed\n");
    expect(find(a).state).toBe("unplaced");
    expect(thoughtStream(app.db, alice).some((t) => t.text === "bob's")).toBe(false);
  });

  test("placed, building, shipped derive from the placed issue and its pull", async () => {
    const i = issue();
    const id = thought("build it", 0.5);
    place(id, [{ action: "opened", repo: slug, number: i.number }], 0.5);
    expect(find(id)).toMatchObject({ state: "placed", flagged: false });
    expect(find(id).placed[0]!.title).toBe(i.title);

    const branch = `b${++n}`;
    await commitToBranch(app, alice, repo, { branch, base: "main", message: "m", files: [{ path: `${branch}.md`, content: "x\n" }] });
    const pull = await openPull(app, alice, repo, {
      title: "p", body: `Closes #${i.number}`, baseBranch: "main", headBranch: branch,
    });
    if (!pull.ok) throw new Error(String(pull.error));
    expect(find(id).state).toBe("building");
    app.db.query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2").run(new Date().toISOString(), pull.value.id);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.value.id);
    expect(find(id).state).toBe("shipped");
  });

  test("flagged only after N days with nothing merged; the setting moves N", () => {
    const i = issue();
    const young = thought("young", 2);
    place(young, [{ action: "opened", repo: slug, number: i.number }], 2);
    const old = thought("old", 4);
    place(old, [{ action: "opened", repo: slug, number: i.number }], 4);
    const idle = thought("a vision", 9);
    place(idle, [], 9);
    expect(find(young).flagged).toBe(false);
    expect(find(old).flagged).toBe(true);
    expect(find(idle).flagged).toBe(false);
    expect(flagDays(app.db, alice.id)).toBe(3);
    setUserSetting(app.db, alice.id, "thoughtFlagDays", "1");
    expect(find(young).flagged).toBe(true);
    setUserSetting(app.db, alice.id, "thoughtFlagDays", "nonsense");
    expect(flagDays(app.db, alice.id)).toBe(3);
    expect(find(thought("unheard", 5)).flagged).toBe(true);
  });

  test("a later thought that supersedes what an earlier one placed is shown", () => {
    const i = issue();
    const first = thought("do it this way", 2);
    place(first, [{ action: "opened", repo: slug, number: i.number }], 2);
    const second = thought("no, not that way", 1);
    place(second, [{ action: "superseded", repo: slug, number: i.number }], 1);
    expect(find(first)).toMatchObject({ state: "superseded", flagged: false });
    expect(find(first).supersededBy).toMatchObject({ id: second, text: "no, not that way" });
    expect(find(second).state).toBe("placed");
  });

  test("a private repository's issue state and name never reach the viewer", async () => {
    const made = await createRepo(app, bob, { name: "secret", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, bob, made.value, { message: "seed", files: [{ path: "README.md", content: "# s\n" }] });
    const hidden = openIssue(app, bob, made.value, { title: "hidden work" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    await commitToBranch(app, bob, made.value, { branch: "fix", base: "main", message: "m", files: [{ path: "f.md", content: "x\n" }] });
    const pull = await openPull(app, bob, made.value, {
      title: "p", body: `Closes #${hidden.value.number}`, baseBranch: "main", headBranch: "fix",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    app.db.query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2").run(new Date().toISOString(), pull.value.id);
    const id = thought("elsewhere", 0.1);
    place(id, [{ action: "opened", repo: "bob/secret", number: hidden.value.number }], 0.1);
    const mine = find(id);
    expect(mine.state).toBe("placed");
    expect(mine.placed[0]).toMatchObject({ readable: false, title: null });
    expect(JSON.stringify(streamJson(mine))).not.toContain("secret");
    // A later thought superseding it changes nothing for someone who cannot read it.
    place(thought("never mind", 0.05), [{ action: "superseded", repo: "bob/secret", number: hidden.value.number }], 0.05);
    expect(find(id).state).toBe("placed");
  });

  test("/asked and the asked tool show the stream, with the one next action", async () => {
    const servers = await serve(app);
    try {
      const i = issue();
      const id = thought("<b>stale</b> thought", 60);
      place(id, [{ action: "opened", repo: slug, number: i.number }], 60);
      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
      const page = (await (await fetch(`${servers.url}/asked`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
      expect(page).toContain("Your thoughts");
      expect(page).toContain("&lt;b&gt;stale&lt;/b&gt; thought");
      expect(page).not.toContain("<b>stale</b>");
      expect(page).toContain("Nothing built");
      expect(page).not.toContain("secret");
      expect(page).toContain("in a repository you cannot read");
      // The one button goes to the oldest flagged thought's issue.
      expect(page).toContain(`data-variant="primary" href="/${slug}/issues/${i.number}"`);
      expect(page).toMatch(/Open the oldest of \d+ with nothing built/);
      const token = createToken(app.db, alice.id, "ro", "ro").token;
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "asked", arguments: {} } }),
      });
      const got = JSON.parse(((await res.json()) as any).result.content[0].text);
      const mine = got.thoughts.find((t: any) => t.id === id);
      expect(mine).toMatchObject({ text: "<b>stale</b> thought", state: "placed", flagged: true });
    } finally {
      servers.stop();
    }
  });
});
