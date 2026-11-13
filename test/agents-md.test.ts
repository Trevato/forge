/** Every repository answers /AGENTS.md; /llms.txt opens with the three doors. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { generatedAgentsMd, threeDoors } from "../src/web/doors_words.ts";
import { createUser, getUserByName as getUserOf } from "../src/core/users.ts";
import { createRepo } from "../src/core/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { agentsMdOf } from "../src/view/agents_md.ts";
import { agentsMdCommands } from "../src/tui/screens/agents_md.ts";
import type { Session } from "../src/tui/session.ts";
import type { Ctx as TuiCtx } from "../src/tui/app/app.ts";
import { tokenFor } from "./helpers/tokens.ts";

let dataDir: string;
let app: ReturnType<typeof createApp>;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-agents-md-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const own = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "owned", visibility: "public" });
  if (!own.ok) throw new Error(String(own.error));
  await commitFiles(repoDir(app.reposRoot, "alice", "owned"), {
    branch: "main",
    message: "add AGENTS.md",
    files: [{ path: "AGENTS.md", content: "# my own rules\nrun bun test\n" }],
    author: { name: "a", email: "a@forge.local" },
  });
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  const secret = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "secret", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  const big = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "big", visibility: "public" });
  if (!big.ok) throw new Error(String(big.error));
  await commitFiles(repoDir(app.reposRoot, "alice", "big"), {
    branch: "main",
    message: "a huge AGENTS.md",
    files: [{ path: "AGENTS.md", content: "x".repeat(210_000) }],
    author: { name: "a", email: "a@forge.local" },
  });
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const base = () => `http://localhost:${servers.port}`;

test("a repository without its own file gets the generated one with the commands", async () => {
  const res = await fetch(`${base()}/alice/notes/AGENTS.md`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await res.text();
  expect(body).toContain("bun install");
  expect(body).toContain("bun test");
  expect(body).toContain("git push origin");
  expect(body).toContain("alice/notes");
});

test("a repository with its own file is answered with it", async () => {
  const res = await fetch(`${base()}/alice/owned/AGENTS.md`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("# my own rules\nrun bun test\n");
});

test("an unknown repository answers 404", async () => {
  expect((await fetch(`${base()}/alice/nothing/AGENTS.md`)).status).toBe(404);
});

test("llms.txt leads with the three doors and the egress host", async () => {
  const body = await (await fetch(`${base()}/llms.txt`)).text();
  expect(body.indexOf("## Three doors")).toBeGreaterThan(-1);
  expect(body.indexOf("## Three doors")).toBeLessThan(body.indexOf("## Start here"));
  expect(body).toContain("git clone");
  expect(body).toContain("git push origin");
  expect(body).toContain("one host");
  expect(body).toContain(`localhost:${servers.port}`);
});

test("the words are the same pure text", () => {
  expect(threeDoors("https://f.example", "https://f.example/mcp").join("\n")).toContain("allow one host, f.example (this forge)");
  expect(generatedAgentsMd("https://f.example", "a", "b", "main")).toContain("archive/main.tar.gz");
});

const get = (path: string, user?: string) =>
  fetch(`${base()}${path}`, user ? { headers: { authorization: `Bearer ${tokenFor(app, user, "ro")}` } } : {});

test("a private repository answers 404 to a guest and to a stranger, 200 to its owner", async () => {
  const guest = await get("/alice/secret/AGENTS.md");
  expect(guest.status).toBe(404);
  expect(await guest.text()).not.toContain("secret");
  expect((await get("/alice/secret/AGENTS.md", "bob")).status).toBe(404);
  const owner = await get("/alice/secret/AGENTS.md", "alice");
  expect(owner.status).toBe(200);
  expect(await owner.text()).toContain("alice/secret");
});

test("an own file over the cap is not served, and the generated text says so", async () => {
  const body = await (await get("/alice/big/AGENTS.md")).text();
  expect(body).toContain("bun install");
  expect(body).toContain("over 200 KB");
  expect(body).not.toContain("xxxxxxxx");
});

test("the terminal offers the same text to whoever may read the repository, and no one else", async () => {
  const session = (user: ReturnType<typeof getUserOf>) => ({ user, db: app.db, app }) as unknown as Session;
  const ctx = { push() {}, pop() {}, invalidate() {}, theme: {} } as unknown as TuiCtx;
  const secret = getRepo(app.db, "alice", "secret")!;
  const notes = getRepo(app.db, "alice", "notes")!;
  expect(agentsMdCommands(session(getUserOf(app.db, "alice")), ctx, secret)).toHaveLength(1);
  expect(agentsMdCommands(session(getUserOf(app.db, "bob")), ctx, secret)).toEqual([]);
  expect(agentsMdCommands(session(undefined), ctx, secret)).toEqual([]);
  expect(agentsMdCommands(session(undefined), ctx, notes)).toHaveLength(1);
  expect(agentsMdCommands(session(undefined), ctx, undefined)).toEqual([]);
  const viaTerminal = await agentsMdOf(app.reposRoot, notes, `http://localhost:${servers.port}`);
  expect(viaTerminal.text).toBe(await (await get("/alice/notes/AGENTS.md")).text());
});
