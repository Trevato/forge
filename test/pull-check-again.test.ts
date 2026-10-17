/**
 * Asking for a check again over HTTP (#1318): only a writer may, a guest is
 * told to sign in, a closed pull is refused, and the pull page offers the
 * button to a writer on an open pull alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let checks: ChecksHandle;
let servers: Servers;
let alice: User;
let bob: User;
let writerToken = "";
let readerToken = "";
let openNumber = 0;
let closedNumber = 0;
const cells = process.env["FORGE_CELLS"];

const mk = async (username: string, first = false): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};

const post = (number: number, token?: string): Promise<Response> =>
  fetch(`${servers.url}/api/v1/repos/alice/gate/pulls/${number}/checks`, {
    method: "POST",
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });

const page = async (user: User, number: number): Promise<string> => {
  const cookie = `forge_session=${createSession(app.db, user.id).token}`;
  const res = await fetch(`${servers.url}/alice/gate/pulls/${number}/files`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  return res.text();
};

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-check-again-"));
  app = createApp({ dataDir, port: 0 });
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 1 });
  servers = await serve(app);
  alice = await mk("alice", true);
  bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "gate", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const commit = async (branch: string | undefined, files: { path: string; content: string }[]) => {
    const done = await commitToBranch(app, alice, repo, {
      ...(branch === undefined ? {} : { branch }),
      message: "change",
      files,
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  };
  await commit(undefined, [
    { path: "forge.json", content: JSON.stringify({ check: { run: "echo ok" } }) },
  ]);
  for (const branch of ["open", "closed"]) {
    await commit(branch, [{ path: `${branch}.txt`, content: branch }]);
    const pull = await openPull(app, alice, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    if (branch === "open") openNumber = pull.value.number;
    else closedNumber = pull.value.number;
  }
  app.db.run("UPDATE issue SET state = 'closed' WHERE number = ?", [closedNumber]);
  writerToken = createToken(app.db, alice.id, "w", "rw").token;
  readerToken = createToken(app.db, bob.id, "r", "rw").token;
});

afterAll(async () => {
  await checks.stop();
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

describe("asking again over HTTP", () => {
  test("a guest is told to sign in; a reader is forbidden", async () => {
    expect((await post(openNumber)).status).toBe(401);
    expect((await post(openNumber, readerToken)).status).toBe(403);
  });

  test("a writer queues a check and gets the run", async () => {
    const res = await post(openNumber, writerToken);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: { reason: string } };
    expect(body.run.reason).toBe("asked");
  });

  test("a closed pull is refused with 409", async () => {
    expect((await post(closedNumber, writerToken)).status).toBe(409);
  });

  test("the page offers Check again to a writer on an open pull only", async () => {
    expect(await page(alice, openNumber)).toContain("Check again");
    expect(await page(bob, openNumber)).not.toContain("Check again");
    expect(await page(alice, closedNumber)).not.toContain("Check again");
  });
});
