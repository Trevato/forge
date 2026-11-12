/**
 * A high finding holds a release where releases happen (#9593): `cut` in
 * `checks/landing.ts` does not swap the landed tree in while one is open in
 * it, and tells the pull; once a person accepts it, the same tree swaps in.
 * The stand-in forge answers the health route as the commit it is told.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptFinding } from "../src/actions/scan_accept.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/app.ts";
import { releaseOnLand } from "../src/checks/landing.ts";
import { scanNightly } from "../src/checks/scan.ts";
import { openHigh } from "../src/checks/scan_store.ts";
import { listComments } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { endSwap, handover } from "../src/release/swap.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const AWS = "AKIA" + "QX7Z".repeat(4);
const OLD = "0".repeat(40);
const STAND_IN = `
if (process.argv.includes("--preflight")) { console.log("preflight ok: stand-in"); process.exit(0); }
Bun.serve({ port: Number(process.env.PORT), reusePort: true, fetch: () => Response.json({ ok: true, draining: false, commit: process.env.FORGE_COMMIT }) });
setTimeout(() => process.exit(0), 6000);
`;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

test("an open high finding in the landed tree holds the swap and tells the pull; accepted, the tree swaps in", async () => {
  handover.migrate = true;
  const port = await freePort();
  const old = Bun.serve({ port, reusePort: true, fetch: () => Response.json({ ok: true, draining: false, commit: OLD }) });
  let drained = 0;
  handover.drain = () => {
    drained++;
    old.stop();
  };
  const dataDir = await mkdtemp(join(tmpdir(), "forge-scan-land-"));
  dirs.push(dataDir);
  const app = createApp({ dataDir, port, forgeRepo: "alice/forge-code", selfSwap: true, swapBudgetMs: 5_000 });
  try {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error("user");
    const r = await createRepo(app, u.value, { name: "forge-code", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    await commitToBranch(app, u.value, r.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
    await commitToBranch(app, u.value, r.value, { message: "b", branch: "change", files: [{ path: "b.txt", content: "b" }] });
    const pull = await openPull(app, u.value, r.value, { title: "t", baseBranch: r.value.defaultBranch, headBranch: "change" });
    if (!pull.ok) throw new Error("pull");
    const made = await commitToBranch(app, u.value, r.value, {
      message: "land",
      files: [{ path: "src/main.ts", content: STAND_IN }, { path: "deploy.ts", content: `export const key = "${AWS}";\n` }],
    });
    if (!made.ok) throw new Error("commit");
    const sha = made.value.commitOid;
    await scanNightly(app, r.value);
    const [secret] = openHigh(app.db, r.value.id);
    expect(secret?.path).toBe("deploy.ts");

    const held = await releaseOnLand(app, u.value, r.value, pull.value, sha);
    expect(held?.ok).toBe(true);
    expect(drained).toBe(0);
    const told = listComments(app.db, pull.value.id).map((c) => c.body);
    expect(told.some((b) => b.includes(`${sha.slice(0, 12)} is not released`) && b.includes("held by 1 open high finding"))).toBe(true);
    expect(told.join("\n")).not.toContain(AWS.slice(4));

    expect(acceptFinding(app, r.value, u.value, secret!.id, "Rotated: the key is revoked")).toEqual({ ok: true });
    await releaseOnLand(app, u.value, r.value, pull.value, sha);
    expect(drained).toBe(1);
  } finally {
    endSwap(false);
    delete handover.drain;
    old.stop(true);
    app.close();
  }
}, 120_000);
