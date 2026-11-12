/** /llms.txt and /api/v1/here name `ssh <forge> tell` when SSH is on, and are silent when off (#6111). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let token: string;
let roToken: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tell-disc-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  token = createToken(app.db, made.value.id, "t", "rw").token;
  roToken = createToken(app.db, made.value.id, "ro", "ro").token;
  const repo = await createRepo(app, made.value, { name: "hello", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
});
afterAll(async () => {
  await servers.stop?.();
  await rm(dir, { recursive: true, force: true });
});

const llms = () => fetch(`${servers.url}/llms.txt`).then((r) => r.text());
const here = async (path = "/", tok = token) =>
  (await fetch(`${servers.url}/api/v1/here?path=${path}`, {
    headers: { authorization: `Bearer ${tok}` },
  }).then((r) => r.json())) as { can: { do: string; ssh?: string }[] };

test("SSH off: neither mentions it", async () => {
  app.config.sshPort = 0;
  expect(await llms()).not.toContain("tell <words>");
  expect((await here()).can.some((a) => a.ssh !== undefined)).toBe(false);
});

test("SSH on: both give the exact command from the forge's own address", async () => {
  app.config.sshPort = 2222;
  const cmd = `ssh -p 2222 ${app.config.host ?? "localhost"} tell <words>`;
  expect(await llms()).toContain(`\`${cmd}\``);
  const a = (await here()).can.find((x) => x.do === "tell the crew");
  expect(a?.ssh).toBe(cmd);
});

test("a repository page puts ssh on its tell verb in `can` for who may direct the crew; a read-only token gets none anywhere", async () => {
  app.config.sshPort = 2222;
  const cmd = `ssh -p 2222 ${app.config.host ?? "localhost"} tell <words>`;
  const repoPage = await here("/alice/hello");
  expect(repoPage.can.find((x) => x.do === "tell the crew")?.ssh).toBe(cmd);
  expect((await here("/", roToken)).can.some((a) => a.ssh !== undefined)).toBe(false);
  expect((await here("/alice/hello", roToken)).can.some((a) => a.ssh !== undefined)).toBe(false);
  app.config.sshPort = 0;
  expect((await here("/alice/hello")).can.some((a) => a.ssh !== undefined)).toBe(false);
});
