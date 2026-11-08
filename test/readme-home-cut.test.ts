/** A repository home draws the first 64 KB of a long README and links to the rest. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cutAtBlock } from "../src/web/pages/repo.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
const cells = process.env["FORGE_CELLS"];

const section = (i: number) =>
  `## Section ${i}\n\nSome prose with *em* and \`code\` for section ${i}, ${"and more words ".repeat(60)}\n\n\`\`\`sh\necho ${i}\n\n\necho again\n\`\`\`\n\n`;
const BIG = `# Manual\n\n${Array.from({ length: 220 }, (_, i) => section(i)).join("")}`;

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-readme-cut-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  for (const [name, content] of [
    ["big", BIG],
    ["small", `# Small\n\n${"words ".repeat(300)}\n`],
  ] as const) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const done = await commitToBranch(app, alice, repo.value, {
      message: "readme",
      files: [{ path: "README.md", content }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

test("a 200 KB README is cut and the home links to the whole of it", async () => {
  expect(BIG.length).toBeGreaterThan(200_000);
  const res = await fetch(`${servers.url}/alice/big`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body.length).toBeLessThan(150_000);
  expect(body).toContain("Section 1<");
  expect(body).not.toContain("Section 219");
  expect(body).toMatch(/<a href="\/alice\/big\/blob\/[^"]+\/README\.md">Read the whole README<\/a>/);
});

test("a 2 KB README renders whole with no link", async () => {
  const res = await fetch(`${servers.url}/alice/small`, { headers: { cookie } });
  const body = await res.text();
  expect(body).toContain("Small");
  expect(body).not.toContain("Read the whole README");
});

test("the cut falls between blocks, never inside a fence", () => {
  const cut = cutAtBlock(BIG, 64 * 1024)!;
  expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(64 * 1024);
  expect((cut.match(/^```/gm) ?? []).length % 2).toBe(0);
  expect(cutAtBlock("short", 64 * 1024)).toBeNull();
});

test("the files page cuts a 200 KB README too, and links to the whole of it", async () => {
  const res = await fetch(`${servers.url}/alice/big/tree/main`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body.length).toBeLessThan(150_000);
  expect(body).not.toContain("Section 219");
  expect(body).toMatch(/<a href="\/alice\/big\/blob\/[^"]+\/README\.md">Read the whole README<\/a>/);
});
