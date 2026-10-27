/** MCP `take_back` (#7211): the pull page's take it back, through `/mcp` with a real token, in the page's words. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { takeBackWords } from "../src/actions/revert_words.ts";
import { getPull, revertOf, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let ada: User;
let repo: Repo;
let shipped: Pull;
let open: Pull;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function takeBack(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "take_back", arguments: args } }),
  });
  const body: any = await res.json();
  const out: string = body.result.content[0].text;
  return body.result.isError === true ? { error: out } : { value: JSON.parse(out) };
}

async function change(branch: string, content: string): Promise<Pull> {
  ok(await commitToBranch(app, ada, repo, {
    branch,
    base: "main",
    message: branch,
    files: [{ path: "code.txt", content }],
  }));
  return ok(await openPull(app, ada, repo, { title: `Make it ${branch}`, baseBranch: "main", headBranch: branch }));
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-take-back-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string, adminIfFirst = false) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
  ada = ok(await make("ada", true));
  const sam = ok(await make("sam"));
  repo = ok(await createRepo(app, ada, { name: "svc", visibility: "private" }));
  ok(await commitToBranch(app, ada, repo, { branch: "main", message: "base", files: [{ path: "code.txt", content: "alpha\n" }] }));
  const loud = await change("loud", "alpha\nBETA\n");
  ok(await mergePull(app, ada, repo, loud, "squash"));
  shipped = getPull(app.db, repo.id, loud.number)!;
  open = await change("quiet", "alpha\ngamma\n");
  const bot = ok(await createAgent(app, ada, { username: "bot" }));
  ok(addToCrew(app, ada, repo, "bot"));
  tok["ada"] = createToken(app.db, ada.id, "rw", "rw").token;
  tok["ada-ro"] = createToken(app.db, ada.id, "ro", "ro").token;
  tok["bot"] = createToken(app.db, bot.user.id, "rw", "rw").token;
  tok["sam"] = createToken(app.db, sam.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const dir = () => repoDir(app.reposRoot, repo.ownerName, repo.name);

test("an agent token is refused in the page's words, and nothing is made", async () => {
  const refused = await takeBack(tok["bot"]!, { repo: "ada/svc", number: shipped.number });
  expect(refused.error).toBe(`forbidden: That could not be taken back: ${takeBackWords("forbidden")}.`);
  expect(await resolveOid(dir(), `refs/heads/revert-${shipped.number}`)).toBeUndefined();
  expect(revertOf(app.db, repo.id, shipped.id)).toBeUndefined();
});

test("a read-only token cannot take a pull back", async () => {
  const refused = await takeBack(tok["ada-ro"]!, { repo: "ada/svc", number: shipped.number });
  expect(refused.error).toBe("forbidden: this token may read, not act");
  expect(revertOf(app.db, repo.id, shipped.id)).toBeUndefined();
});

test("an open pull has not shipped", async () => {
  const refused = await takeBack(tok["ada"]!, { repo: "ada/svc", number: open.number });
  expect(refused.error).toBe(`not_shipped: That could not be taken back: ${takeBackWords("not_shipped")}.`);
});

test("a pull the caller cannot see, or no pull at all, is not found", async () => {
  expect((await takeBack(tok["sam"]!, { repo: "ada/svc", number: shipped.number })).error).toStartWith("not_found:");
  const none = await takeBack(tok["ada"]!, { repo: "ada/svc", number: 999 });
  expect(none.error).toBe(`not_found: That could not be taken back: ${takeBackWords("not_found")}.`);
  expect((await takeBack(tok["ada"]!, { repo: "ada/svc", number: "1" })).error).toBe(
    `not_found: That could not be taken back: ${takeBackWords("not_found")}.`,
  );
});

test("a shipped pull opens the pull that undoes it; a second call is already taken back", async () => {
  const made = await takeBack(tok["ada"]!, { repo: "ada/svc", number: shipped.number });
  expect(made.error).toBeUndefined();
  const revert = revertOf(app.db, repo.id, shipped.id)!;
  expect(revert).toBeDefined();
  expect(made.value).toMatchObject({
    number: revert.number,
    title: 'Revert "Make it loud"',
  });
  expect(made.value.url).toEndWith(`/ada/svc/pulls/${revert.number}`);
  expect(made.value.says).toBe('Opened "Revert "Make it loud"" — ship it to take "Make it loud" back.');
  expect(revert.headBranch).toBe(`revert-${shipped.number}`);
  expect(revert.state).toBe("open");

  const again = await takeBack(tok["ada"]!, { repo: "ada/svc", number: shipped.number });
  expect(again.error).toBe(`already_reverted: That could not be taken back: ${takeBackWords("already_reverted")}.`);
});

test("a revert that no longer applies is a conflict, and leaves nothing behind", async () => {
  const ship = async (branch: string, content: string): Promise<Pull> => {
    const made = await change(branch, content);
    ok(await mergePull(app, ada, repo, made, "squash"));
    return getPull(app.db, repo.id, made.number)!;
  };
  // `later` rewrites the very line `earlier` wrote, so undoing `earlier` cannot apply.
  const earlier = await ship("gamma", "alpha\nGAMMA\n");
  await ship("delta", "alpha\nDELTA\n");
  const refused = await takeBack(tok["ada"]!, { repo: "ada/svc", number: earlier.number });
  expect(refused.error).toBe("conflict: That could not be taken back: it conflicts with the current code in code.txt.");
  expect(await resolveOid(dir(), `refs/heads/revert-${earlier.number}`)).toBeUndefined();
  expect(revertOf(app.db, repo.id, earlier.id)).toBeUndefined();
});
