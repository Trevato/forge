/**
 * An issue or a pull takes a new title or body after it was opened. The
 * author may, any author; a person who writes the repository may; an agent
 * edits only what it wrote; a reader and a stranger are refused, by the
 * API, the form and the MCP tool alike. What a pull closes follows its new
 * body, and the edit is an event that names what changed and never the
 * words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  assignIssue,
  editIssue,
  openIssue,
  TAKEN_UP,
} from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { openPullsClosing, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { setMember } from "../src/core/roles.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const PASSWORD = "a-good-passphrase";

describe("new words for an issue or a pull", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let bot: User;
  let repo: Repo;
  let vault: Repo;
  let asked: Issue;
  let hidden: Issue;
  let pull: Pull;
  const tokens: Record<string, string> = {};

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const patch = (
    token: string | null,
    path: string,
    payload: unknown,
  ): Promise<Response> =>
    fetch(`${base}/api/v1/repos${path}`, {
      method: "PATCH",
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${base}/mcp`, {
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
        params: { name: "edit", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text, value: undefined }
      : { error: undefined, value: JSON.parse(text) };
  };
  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: PASSWORD }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const form = (path: string, cookie: string, fields: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
  const page = async (path: string, cookie = "") =>
    (
      await fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} })
    ).text();
  const words = (issue: { id: string }) => {
    const now = getIssueById(app.db, issue.id)!;
    return { title: now.title, body: now.body };
  };
  /** The edits of one kind, newest first, as the outbox lists them. */
  const edits = (kind: string) =>
    listEvents(app.db, { repoId: repo.id, limit: 100 }).filter(
      (e) => e.kind === kind,
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edit-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await person("alice");
    bob = await person("bob");
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    for (const [name, visibility] of [
      ["garden", "public"],
      ["vault", "private"],
    ] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      await commitToBranch(app, alice, made.value, {
        message: "seed",
        files: [{ path: "README.md", content: `# ${name}\n` }],
      });
      if (name === "garden") repo = made.value;
      else vault = made.value;
    }
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const opened = openIssue(app, alice, repo, {
      title: "Water the beds",
      body: "They are dry.",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    asked = opened.value;
    const second = openIssue(app, alice, repo, { title: "Weed the rows" });
    if (!second.ok) throw new Error(String(second.error));
    const secret = openIssue(app, alice, vault, { title: "The combination" });
    if (!secret.ok) throw new Error(String(secret.error));
    hidden = secret.value;
    await commitToBranch(app, alice, repo, {
      branch: "bot/beds",
      base: "main",
      message: "beds",
      files: [{ path: "beds.md", content: "wet\n" }],
    });
    const pulled = await openPull(app, bot, repo, {
      title: "Water the beds",
      body: "WIP",
      baseBranch: "main",
      headBranch: "bot/beds",
    });
    if (!pulled.ok) throw new Error(String(pulled.error));
    pull = pulled.value;
    tokens["alice"] = createToken(app.db, alice.id, "t", "rw").token;
    tokens["aliceRo"] = createToken(app.db, alice.id, "t", "ro").token;
    tokens["bob"] = createToken(app.db, bob.id, "t", "rw").token;
    tokens["bot"] = createToken(app.db, bot.id, "run", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger and a reader cannot edit, by the API, the MCP, the form or the action", async () => {
    const before = words(pull);
    expect(
      (await patch(null, `/alice/garden/pulls/${pull.number}`, { body: "x" }))
        .status,
    ).toBe(401);
    expect(
      (
        await patch(tokens["bob"]!, `/alice/garden/pulls/${pull.number}`, {
          body: "mine now",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(tokens["bob"]!, `/alice/garden/issues/${asked.number}`, {
          title: "Mine now",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(tokens["aliceRo"]!, `/alice/garden/pulls/${pull.number}`, {
          body: "ro",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await mcp(tokens["bob"]!, {
          repo: "alice/garden",
          number: pull.number,
          body: "mine now",
        })
      ).error,
    ).toContain("forbidden");
    const cookie = await signIn("bob");
    const sent = await form(`/alice/garden/pulls/${pull.number}/edit`, cookie, {
      title: "Mine now",
      body: "mine now",
    });
    expect(sent.status).toBe(303);
    expect(
      await page(`/alice/garden/pulls/${pull.number}`, cookie),
    ).not.toContain('id="edit"');
    expect(editIssue(app, bob, repo, pull, { body: "x" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(editIssue(app, undefined, repo, pull, { body: "x" })).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(words(pull)).toEqual(before);
    expect(edits("pull.edited")).toHaveLength(0);
  });

  test("what cannot be seen cannot be edited, and answers as if it were not there", async () => {
    const unseen = await patch(
      tokens["bob"]!,
      `/alice/vault/issues/${hidden.number}`,
      {
        title: "x",
      },
    );
    const missing = await patch(tokens["bob"]!, `/alice/vault/issues/999`, {
      title: "x",
    });
    expect(unseen.status).toBe(404);
    expect(await unseen.json()).toEqual(await missing.json());
    expect(editIssue(app, bob, vault, hidden, { title: "x" })).toEqual({
      ok: false,
      error: "not_found",
    });
    // An issue of another repository is not this one's to edit.
    expect(editIssue(app, alice, vault, asked, { title: "x" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(words(hidden).title).toBe("The combination");
    // A sealed report on the public garden is, to a reader, not there.
    const sealed = openIssue(app, alice, repo, {
      title: "A hole in the fence",
      sealed: true,
    });
    if (!sealed.ok) throw new Error(String(sealed.error));
    expect(
      (
        await patch(
          tokens["bob"]!,
          `/alice/garden/issues/${sealed.value.number}`,
          {
            title: "x",
          },
        )
      ).status,
    ).toBe(404);
    expect(editIssue(app, bob, repo, sealed.value, { title: "x" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      (
        await mcp(tokens["bob"]!, {
          repo: "alice/garden",
          number: sealed.value.number,
          title: "x",
        })
      ).error,
    ).toBeDefined();
    expect(words(sealed.value).title).toBe("A hole in the fence");
  });

  test("an agent edits only what it wrote: its own pull, never a person's issue", async () => {
    expect(
      (
        await patch(tokens["bot"]!, `/alice/garden/issues/${asked.number}`, {
          body: "an agent's rewrite",
        })
      ).status,
    ).toBe(403);
    expect(words(asked).body).toBe("They are dry.");
    const res = await patch(
      tokens["bot"]!,
      `/alice/garden/pulls/${pull.number}`,
      {
        body: `Closes #${asked.number}\n\nThe beds are watered twice a day.`,
      },
    );
    expect(res.status).toBe(200);
    const shown = (await res.json()) as any;
    expect(shown.body).toStartWith(`Closes #${asked.number}`);
    expect(shown.title).toBe("Water the beds");
    // What it closes is read from the new body.
    expect(openPullsClosing(app.db, repo.id).get(asked.number)?.id).toBe(
      pull.id,
    );
    const event = edits("pull.edited");
    expect(event).toHaveLength(1);
    expect(event[0]!.actorId).toBe(bot.id);
    expect(event[0]!.payload).toEqual({
      number: pull.number,
      changed: ["body"],
    });
  });

  test("a person who writes edits anyone's words, title and body, and a state in the same breath", async () => {
    const res = await patch(
      tokens["alice"]!,
      `/alice/garden/pulls/${pull.number}`,
      {
        title: "Water the beds twice a day",
        body: `Closes #${asked.number}\n\nDone, with a timer.`,
      },
    );
    expect(res.status).toBe(200);
    expect(words(pull)).toEqual({
      title: "Water the beds twice a day",
      body: `Closes #${asked.number}\n\nDone, with a timer.`,
    });
    const second = edits("pull.edited")[0]!;
    expect(second.payload).toEqual({
      number: pull.number,
      changed: ["title", "body"],
    });
    // The event says what changed and nothing of what it says now.
    expect(JSON.stringify(second.payload)).not.toContain("timer");
    // An issue: new words and a close together.
    const closed = await patch(
      tokens["alice"]!,
      `/alice/garden/issues/${asked.number}`,
      {
        title: "Water the beds (done)",
        state: "closed",
        reason: "done",
      },
    );
    expect(closed.status).toBe(200);
    const after = getIssueById(app.db, asked.id)!;
    expect([after.title, after.state]).toEqual([
      "Water the beds (done)",
      "closed",
    ]);
    expect(edits("issue.edited")[0]!.payload).toEqual({
      number: asked.number,
      changed: ["title"],
    });
  });

  test("a PATCH with nothing in it, or the wrong shape, is refused before anything moves", async () => {
    for (const [payload, error] of [
      [{}, "nothing_to_change"],
      [{ title: 7 }, "invalid_text"],
      [{ body: ["x"] }, "invalid_text"],
      [{ title: "  " }, "empty_title"],
      [{ title: "x".repeat(300) }, "title_too_long"],
      [{ state: "ajar" }, "invalid_state"],
    ] as const) {
      const res = await patch(
        tokens["alice"]!,
        `/alice/garden/pulls/${pull.number}`,
        payload,
      );
      expect(res.status).toBe(422);
      expect(((await res.json()) as any).error).toBe(error);
    }
    // The same words again change nothing and say nothing.
    const count = edits("pull.edited").length;
    const same = await patch(
      tokens["alice"]!,
      `/alice/garden/pulls/${pull.number}`,
      {
        title: words(pull).title,
      },
    );
    expect(same.status).toBe(200);
    expect(edits("pull.edited")).toHaveLength(count);
  });

  test("the MCP edit tool, by number, for an issue or a pull", async () => {
    const told = await mcp(tokens["bot"]!, {
      repo: "alice/garden",
      number: pull.number,
      body: `Closes #${asked.number}\n\nWatered, weeded, done.`,
    });
    expect(told.error).toBeUndefined();
    expect(told.value.says).toBe(
      `Edited #${pull.number}: Water the beds twice a day`,
    );
    expect(words(pull).body).toEndWith("Watered, weeded, done.");
    expect(
      (
        await mcp(tokens["alice"]!, {
          repo: "alice/garden",
          number: pull.number,
        })
      ).error,
    ).toContain("nothing_to_change");
    expect(
      (
        await mcp(tokens["alice"]!, {
          repo: "alice/garden",
          number: 999,
          title: "x",
        })
      ).error,
    ).toContain("no_such_issue");
    // A read-only token does not act.
    expect(
      (
        await mcp(tokens["aliceRo"]!, {
          repo: "alice/garden",
          number: pull.number,
          title: "x",
        })
      ).error,
    ).toBeDefined();
  });

  test("the folded Edit form is plain fields, not a boxed card", async () => {
    const html = await page(`/alice/garden/pulls/${pull.number}`, await signIn("alice"));
    const at = html.indexOf('<details class="tl-edit" id="edit">');
    expect(at).toBeGreaterThan(-1);
    const fold = html.slice(at, html.indexOf("</details>", at));
    const open = fold.match(/<form[^>]*>/)![0];
    expect(open).not.toMatch(/\bcard\b/);
    expect(open).not.toContain("comment-form");
    expect(fold).toContain('name="title"');
    expect(fold).toContain('name="body"');
    expect(fold).toContain("Save");
  });

  test("the pages offer Edit to the author and a writer, and the form saves", async () => {
    const mine = await signIn("alice");
    const change = `/alice/garden/pulls/${pull.number}`;
    const before = await page(change, mine);
    expect(before).toContain('id="edit"');
    expect(before).toContain(`action="${change}/edit"`);
    const saved = await form(`${change}/edit`, mine, {
      title: "Water the beds, twice",
      body: `Closes #${asked.number}\n\nFrom the page.`,
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(change);
    expect(words(pull)).toEqual({
      title: "Water the beds, twice",
      body: `Closes #${asked.number}\n\nFrom the page.`,
    });
    const after = await page(change, mine);
    expect(after).toContain("Water the beds, twice");
    expect(after).toContain("From the page.");
    // The timeline says it was edited, without the words.
    expect(after).toContain("edited this");
    // An empty title is refused with a word, and nothing moves.
    const blank = await form(`${change}/edit`, mine, { title: " ", body: "x" });
    expect(blank.status).toBe(303);
    expect(words(pull).title).toBe("Water the beds, twice");
    // The issue page has the same door for its author.
    const tell = await page(`/alice/garden/issues/${asked.number}`, mine);
    expect(tell).toContain(
      `action="/alice/garden/issues/${asked.number}/edit"`,
    );
    // A stranger sees neither.
    const anonymous = await page(change);
    expect(anonymous).not.toContain('id="edit"');
  });
  test("an author who cannot direct the crew edits an issue only until a writer adopts it", async () => {
    // Bob reads the garden and may not direct its crew. His suggestion is
    // his to reword while nobody who directs the crew has acted on it.
    const made = openIssue(app, bob, repo, {
      title: "Plant tulips",
      body: "By the gate.",
    });
    if (!made.ok) throw new Error(String(made.error));
    const tulips = made.value;
    const path = `/alice/garden/issues/${tulips.number}`;
    expect(
      (await patch(tokens["bob"]!, path, { body: "By the gate, in rows." }))
        .status,
    ).toBe(200);
    expect(words(tulips).body).toBe("By the gate, in rows.");
    const his = await signIn("bob");
    expect(await page(path, his)).toContain(`action="${path}/edit"`);

    // Alice adopts it: it is the crew's work now, as she read it.
    expect(assignIssue(app, alice, repo, tulips, bot).ok).toBe(true);
    const refused = await patch(tokens["bob"]!, path, {
      body: "Dig up the roses instead.",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toBe("taken_up");
    expect(
      (
        await mcp(tokens["bob"]!, {
          repo: "alice/garden",
          number: tulips.number,
          body: "x",
        })
      ).error,
    ).toContain(TAKEN_UP);
    expect(
      (await form(`${path}/edit`, his, { title: "Roses", body: "x" })).status,
    ).toBe(303);
    expect(editIssue(app, bob, repo, tulips, { body: "x" })).toEqual({
      ok: false,
      error: "taken_up",
    });
    expect(words(tulips).body).toBe("By the gate, in rows.");
    expect(await page(path, his)).not.toContain('id="edit"');
    // Taken back is not handed back: the next assignment would hand the
    // crew whatever he says by then.
    expect(assignIssue(app, alice, repo, tulips, null).ok).toBe(true);
    expect(
      (await patch(tokens["bob"]!, path, { body: "Dig up the roses instead." }))
        .status,
    ).toBe(403);
    expect(editIssue(app, bob, repo, tulips, { body: "x" })).toEqual({
      ok: false,
      error: "taken_up",
    });
    // The writer still may.
    expect(
      (
        await patch(tokens["alice"]!, path, {
          title: "Plant tulips by the gate",
        })
      ).status,
    ).toBe(200);
  });

  test("an agent edits its own pull only until a person approved it", async () => {
    const path = `/alice/garden/pulls/${pull.number}`;
    expect(
      (
        await patch(tokens["bot"]!, path, {
          body: `Closes #${asked.number}\n\nBefore the approval.`,
        })
      ).status,
    ).toBe(200);
    // The crew's own reviewer approving is not a person's word on it.
    const quill = await createAgent(app, alice, { username: "quill" });
    if (!quill.ok) throw new Error(String(quill.error));
    expect(
      submitReview(app.db, {
        issueId: pull.id,
        authorId: quill.value.user.id,
        state: "approved",
        commitOid: pull.headOid,
      }).ok,
    ).toBe(true);
    expect(
      (
        await patch(tokens["bot"]!, path, {
          body: `Closes #${asked.number}\n\nStill before a person's.`,
        })
      ).status,
    ).toBe(200);
    expect(
      submitReview(app.db, {
        issueId: pull.id,
        authorId: alice.id,
        state: "approved",
        commitOid: pull.headOid,
      }).ok,
    ).toBe(true);
    const refused = await patch(tokens["bot"]!, path, {
      body: "Closes #2\n\nAfter.",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toBe("taken_up");
    expect(words(pull).body).toEndWith("Still before a person's.");
    // A person who writes still may.
    expect(
      (
        await patch(tokens["alice"]!, path, {
          title: "Water the beds, approved",
        })
      ).status,
    ).toBe(200);
  });

  test("an outside contributor edits a pull only until a writer reviews it", async () => {
    await commitToBranch(app, alice, repo, {
      branch: "bob/tulips",
      base: "main",
      message: "tulips",
      files: [{ path: "tulips.md", content: "red\n" }],
    });
    // A member who cannot write here sends from a branch; a guest needs a fork.
    setMember(app.db, bob.id, true, alice.id, new Date());
    const opened = await openPull(app, bob, repo, {
      title: "Tulips",
      body: "Red ones.",
      baseBranch: "main",
      headBranch: "bob/tulips",
    });
    setMember(app.db, bob.id, false, alice.id, new Date());
    if (!opened.ok) throw new Error(String(opened.error));
    const theirs = opened.value;
    const path = `/alice/garden/pulls/${theirs.number}`;
    expect(
      (await patch(tokens["bob"]!, path, { body: "Red ones, by the gate." }))
        .status,
    ).toBe(200);

    // A stranger's comment-review is not a director acting: his words stay his.
    const carol = await person("carol");
    expect(
      submitReview(app.db, {
        issueId: theirs.id,
        authorId: carol.id,
        state: "commented",
        commitOid: theirs.headOid,
      }).ok,
    ).toBe(true);
    expect(
      (await patch(tokens["bob"]!, path, { body: "Red ones, in a row." }))
        .status,
    ).toBe(200);

    // Alice approved what she read; a new "Closes #N" under it is not his to add.
    const reviewed = submitReview(app.db, {
      issueId: theirs.id,
      authorId: alice.id,
      state: "approved",
      commitOid: theirs.headOid,
    });
    expect(reviewed.ok).toBe(true);
    const refused = await patch(tokens["bob"]!, path, {
      body: `Closes #${asked.number}\n\nRed ones, by the gate.`,
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as any).error).toBe("taken_up");
    expect(editIssue(app, bob, repo, theirs, { title: "Roses" })).toEqual({
      ok: false,
      error: "taken_up",
    });
    expect(words(theirs)).toEqual({
      title: "Tulips",
      body: "Red ones, in a row.",
    });
    expect(openPullsClosing(app.db, repo.id).get(asked.number)?.id).not.toBe(
      theirs.id,
    );
    // The writer still may.
    expect(
      (await patch(tokens["alice"]!, path, { title: "Tulips by the gate" }))
        .status,
    ).toBe(200);
  });
});
