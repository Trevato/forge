/**
 * `ssh <forge> tell` as a spawned forge's first ask (#11975): it makes a new
 * app and files the ask there, never on the forge's own source; the next tell
 * goes to the forge's repository as before.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { createUser } from "../src/core/users.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import type { SshSession } from "../src/ssh/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo carol";

let dir = "";
let app: App;

const exec = async (command: string) => {
  const parsed = parseAuthorizedKey(KEY);
  if (!parsed.ok) throw new Error("key");
  let out = "";
  let err = "";
  let code: number | undefined;
  await new Promise<void>((resolve) => {
    const session: SshSession = {
      key: { algo: parsed.value.algo, blob: parsed.value.blob, fingerprint: fingerprint(parsed.value.blob), line: KEY },
      username: "whoever",
      remoteAddress: "203.0.113.9",
      kind: "exec",
      command,
      term: undefined,
      env: {},
      cols: 0,
      rows: 0,
      widthPx: 0,
      heightPx: 0,
      ended: false,
      pending: 0,
      write: (d: Uint8Array | string) => void (out += typeof d === "string" ? d : Buffer.from(d).toString()),
      writeStderr: (d: string) => void (err += d),
      onData() {},
      onResize() {},
      onEof() {},
      onClose() {},
      exit(c: number) {
        code ??= c;
        resolve();
      },
      drain: async () => {},
    };
    forgeSshSession(app)(session);
  });
  return { out, err, code };
};

const issuesOn = (name: string) =>
  app.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = (SELECT id FROM repo WHERE name = ?1)")
    .get(name)!.n;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-ssh-first-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "carol/forge", url: "https://forge.test" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "carol",
    email: "carol@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const parsed = parseAuthorizedKey(KEY);
  if (!parsed.ok) throw new Error("key");
  addKey(app.db, u.value.id, "laptop", parsed.value);
  const org = createOrg(app.db, "kin", u.value.id);
  if (!org.ok) throw new Error(org.error);
  await Bun.write(join(dir, "parent.json"), JSON.stringify({ org: "kin" }));
  const made = await createRepo(app, u.value, { owner: "carol", name: "forge" });
  if (!made.ok) throw new Error(made.error);
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the first tell makes a new app and files there; the second goes to the forge's repository", async () => {
  const first = await exec("tell a weekly menu page for the bakery");
  expect(first.code).toBe(0);
  expect(first.out).toContain("/carol/");
  expect(first.out).not.toContain("/carol/forge/");
  expect(issuesOn("forge")).toBe(0);
  const second = await exec("tell make it blue");
  expect(second.code).toBe(0);
  expect(second.out).toContain("/carol/forge/issues/");
  expect(issuesOn("forge")).toBe(1);
});
