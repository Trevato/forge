/** The forges list joins the shell's j/k row traversal (#10354): one data-nav per forge, none on the empty page. */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { useChildFetch } from "../src/spawn/clients.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dirs: string[] = [];
const apps: App[] = [];
const servers: Servers[] = [];

async function boot(names: string[]): Promise<{ url: string; bearer: string; app: App }> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-keys-forges-"));
  dirs.push(dataDir);
  const app = createApp({ dataDir, port: 0 });
  apps.push(app);
  useChildFetch(app, async () => new Response("{}", { status: 404 }));
  const s = await serve(app);
  servers.push(s);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  await mkdir(join(dataDir, "spawn"), { recursive: true });
  for (const name of names)
    await Bun.write(
      join(dataDir, "spawn", `${name}.json`),
      JSON.stringify({ name, bodyId: `body-${name}`, url: `https://${name}.example.test`, planHash: "x", done: false, forWhom: "Maria", apps: ["notes"] }),
    );
  return { url: s.url, bearer: createToken(app.db, made.value.id, "t", "admin").token, app };
}

afterAll(async () => {
  for (const s of servers) await s.stop();
  for (const a of apps) a.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("each forge row is one data-nav holding the link to that forge", async () => {
  const { url, bearer } = await boot(["maria", "omar", "lena"]);
  const res = await fetch(`${url}/forges`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  const text = await res.text();
  const rows = text.split("data-nav").slice(1);
  expect(rows.length).toBe(3);
  const names = ["maria", "omar", "lena"];
  for (const name of names) {
    const row = rows.find((r) => r.includes(`>${name}</a>`));
    expect(row).toBeDefined();
    // The row's first <a> is that forge's own link.
    const first = /<a href="([^"]+)">([^<]*)<\/a>/.exec(row!);
    expect(first![2]).toBe(name);
    expect(first![1]).toContain(name);
  }
});

test("the empty page draws no data-nav", async () => {
  const { url, bearer } = await boot([]);
  const res = await fetch(`${url}/forges`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("No forges sent yet");
  expect(text).not.toContain("data-nav");
});
