/**
 * The off-site backup lane (#11805): the mirror pass writes only ciphertext
 * under names that hide every path, a restore from it with the passphrase
 * brings the forge back, the drill restores from it and keeps where, and
 * `/system` says when the lane last succeeded.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { answersRoot, runDrill, type DrillResult } from "../src/snapshot/drill.ts";
import { lastDrill } from "../src/snapshot/drills.ts";
import { lastMirror, mirrorPass, NO_PASSPHRASE, offsiteFromEnv, resolveMirror } from "../src/snapshot/mirror.ts";
import { parseArgs } from "../scripts/restore-drill.ts";
import { offsiteLane, readOffsiteLane } from "../src/snapshot/offsite_lane.ts";
import { restoreSnapshot } from "../src/snapshot/restore.ts";
import { hiddenKey, LANE_HEADER, openBody, parseHeader, sealBody, sealedStore, sealKeys, SEALED_PREFIX } from "../src/snapshot/sealed_store.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { listSnapshots, SNAPSHOT_PREFIX } from "../src/snapshot/snapshot.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";
import { tool as systemTool } from "../src/http/mcp/tools/system.ts";
import { Session } from "../src/tui/forge.ts";
import { offsiteLines } from "../src/tui/screens/offsite.ts";
import { FOOTING } from "../src/system/footing.ts";
import { offsiteSection } from "../src/web/pages/system.ts";

const PASS = "a long operator passphrase";
const SALT = new Uint8Array(16).fill(7);

function files(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

describe("the sealed store", () => {
  test("a body goes in as ciphertext and comes back whole; the wrong passphrase or a changed byte does not open", async () => {
    const k = await sealKeys(PASS, SALT);
    const sealed = sealBody(k, "SQLite format 3 and a secret");
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("SQLite");
    expect(Buffer.from(openBody(k, sealed, "x")).toString()).toBe("SQLite format 3 and a secret");
    expect(() => openBody(k, sealed, "x")).not.toThrow();
    const other = await sealKeys("not the passphrase", SALT);
    expect(() => openBody(other, sealed, "x")).toThrow("wrong passphrase");
    // The same passphrase under another lane's salt is another key.
    const otherSalt = await sealKeys(PASS, new Uint8Array(16).fill(8));
    expect(() => openBody(otherSalt, sealed, "x")).toThrow("did not open");
    const changed = new Uint8Array(sealed);
    changed[20] = changed[20]! ^ 1;
    expect(() => openBody(k, changed, "x")).toThrow("did not open");
    expect(() => openBody(k, new TextEncoder().encode("plain"), "x")).toThrow("not a sealed object");
  });

  test("a path inside a snapshot is hidden; the snapshot's name stays; a listed key reads back", async () => {
    const k = await sealKeys(PASS, SALT);
    const hidden = hiddenKey(k, "snapshots/2026-11-12T03-00-00Z/repos/alice/private-plans.bundle");
    expect(hidden).toMatch(/^snapshots\/2026-11-12T03-00-00Z\/[0-9a-f]{64}$/);
    expect(hiddenKey(k, hidden)).toBe(hidden);
  });

  test("each lane keeps a random salt of its own in an unsealed header; a wrong passphrase is said before any object is read", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-offsite-salt-"));
    try {
      const one = sealedStore(dirStore(join(root, "one")), PASS);
      const two = sealedStore(dirStore(join(root, "two")), PASS);
      await one.put("snapshots/2026-11-12T03-00-00Z/x", "body");
      await two.put("snapshots/2026-11-12T03-00-00Z/x", "body");
      const h1 = parseHeader(readFileSync(join(root, "one", LANE_HEADER)));
      const h2 = parseHeader(readFileSync(join(root, "two", LANE_HEADER)));
      if (typeof h1 === "string" || typeof h2 === "string") throw new Error("no header");
      expect(h1.salt.length).toBe(16);
      expect(h1.salt.equals(h2.salt)).toBe(false);
      expect(readFileSync(join(root, "one", LANE_HEADER), "utf8")).not.toContain(PASS);
      // Same passphrase, same path, other salt: the hidden names differ, so nothing computed for one lane serves the other.
      expect(await one.list("snapshots/")).not.toEqual(await two.list("snapshots/"));
      // A reopened lane reads its own salt back.
      expect(new TextDecoder().decode(await sealedStore(dirStore(join(root, "one")), PASS).get("snapshots/2026-11-12T03-00-00Z/x"))).toBe("body");
      await expect(sealedStore(dirStore(join(root, "one")), "not it").get("snapshots/2026-11-12T03-00-00Z/x")).rejects.toThrow("does not open the lane");
      // A reader (a restore) never starts a lane on an empty bucket.
      await expect(sealedStore(dirStore(join(root, "empty")), PASS, { create: false }).list("snapshots/")).rejects.toThrow("holds no sealed lane");
      expect(parseHeader(new TextEncoder().encode('{"v":1,"salt":"zz","check":"00"}'))).toBeTypeOf("string");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("without a passphrase the lane fails closed: no request reaches the bucket, and the board says why", async () => {
    const seen: string[] = [];
    const bucket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(`${req.method} ${new URL(req.url).pathname}`), new Response("", { status: 200 })) });
    const root = mkdtempSync(join(tmpdir(), "forge-offsite-closed-"));
    try {
      const env = {
        FORGE_MIRROR_S3_ENDPOINT: `http://127.0.0.1:${String(bucket.port)}`,
        FORGE_MIRROR_S3_BUCKET: "offsite",
        FORGE_MIRROR_S3_ACCESS_KEY: "a",
        FORGE_MIRROR_S3_SECRET_KEY: "s",
      };
      const plain = resolveMirror({ env });
      expect(plain?.encrypted).toBe(false);
      expect(plain?.store.sealed).toBeUndefined();
      await expect(plain!.store.put("snapshots/x/forge.db", "SQLite format 3")).rejects.toThrow(NO_PASSPHRASE);
      const primary = dirStore(join(root, "primary"));
      await primary.put("snapshots/2026-11-12T03-00-00Z/forge.db", "SQLite format 3");
      await primary.put("snapshots/2026-11-12T03-00-00Z/manifest.json", JSON.stringify({ name: "2026-11-12T03-00-00Z", startedAt: "2026-11-12T03:00:00Z", finishedAt: "2026-11-12T03:01:00Z", files: [] }));
      const state = await mirrorPass(root, primary, plain!.store);
      expect(seen).toEqual([]);
      expect(state.error).toBe(NO_PASSPHRASE);
      const lane = offsiteLane(state, undefined, Date.now());
      expect(lane.health).toBe("unsealed");
      expect(String(offsiteSection(lane))).toContain("writes nothing until FORGE_SNAPSHOT_PASSPHRASE is set");

      const sealed = resolveMirror({ env, passphrase: PASS });
      expect(sealed?.encrypted).toBe(true);
      expect(sealed?.store.sealed).toBe(true);
      expect(sealed?.store.where).toBe(`127.0.0.1:${String(bucket.port)}/offsite (sealed)`);
    } finally {
      await bucket.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a restore on a fresh machine reads the lane from the environment, and only with the passphrase", async () => {
    const lane = {
      FORGE_MIRROR_S3_ENDPOINT: "https://s3.b2.example.com",
      FORGE_MIRROR_S3_BUCKET: "offsite",
      FORGE_MIRROR_S3_ACCESS_KEY: "a",
      FORGE_MIRROR_S3_SECRET_KEY: "s",
    };
    expect(offsiteFromEnv({})).toStartWith("no off-site lane");
    expect(offsiteFromEnv(lane)).toBe("the off-site lane is sealed: export FORGE_SNAPSHOT_PASSPHRASE");
    const store = offsiteFromEnv({ ...lane, FORGE_SNAPSHOT_PASSPHRASE: PASS });
    expect(typeof store === "string" ? store : store.sealed).toBe(true);
    expect(parseArgs(["/tmp/x", "--offsite"])).toMatchObject({ dataDir: "/tmp/x", offsite: true });
    expect(parseArgs(["/tmp/x"])).not.toHaveProperty("offsite");
    // The card's command refuses before it touches the network or the directory.
    const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", ...lane };
    const run = Bun.spawnSync([process.execPath, "run", "src/snapshot/restore.ts", "latest", join(tmpdir(), "never-written"), "--offsite"], {
      cwd: join(import.meta.dir, ".."),
      env,
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain("the off-site lane is sealed");
  });

});

describe("the off-site lane end to end", () => {
  let root: string;
  let app: App;
  let offDir: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-offsite-"));
    offDir = join(root, "offsite-bucket");
    app = createApp({ dataDir: join(root, "data"), port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the pass seals every object, a restore with the passphrase brings the forge back, and the drill restores from it", async () => {
    const mirror = sealedStore(dirStore(offDir), PASS);
    const svc = startSnapshots(app, dirStore(join(root, "primary")), {
      version: "t",
      nightly: false,
      passphrase: PASS,
      mirror,
      drill: (deps) => runDrill({ ...deps, boot: async () => ({ ok: true, reason: "" }) }),
    });
    const m = await svc.now();
    const state = await svc.mirrorFresh();
    expect(state?.failingSince).toBeUndefined();
    expect(state?.sealed).toBe(true);
    expect(lastMirror(app.config.dataDir)?.sealed).toBe(true);

    // On the bucket: only `sealed/snapshots/<name>/<hmac>`, and not one plain byte of the database or the manifest.
    const onBucket = files(offDir);
    // Every object of the snapshot and its manifest, and the lane's header.
    expect(onBucket.length).toBe(m.files.length + 2);
    expect(onBucket.map((f) => relative(offDir, f))).toContain(LANE_HEADER);
    for (const f of onBucket.filter((f) => relative(offDir, f) !== LANE_HEADER)) {
      expect(relative(offDir, f)).toMatch(new RegExp(`^${SEALED_PREFIX}${SNAPSHOT_PREFIX}${m.name}/[0-9a-f]{64}$`));
      const raw = readFileSync(f).toString("latin1");
      expect(raw.startsWith("FSO1")).toBe(true);
      expect(raw).not.toContain("SQLite format");
      expect(raw).not.toContain('"startedAt"');
    }

    // The lane lists and restores like any store, given the passphrase; another passphrase opens nothing.
    expect((await listSnapshots(mirror)).map((x) => x.name)).toEqual([m.name]);
    const target = join(root, "restored");
    const done = await restoreSnapshot(sealedStore(dirStore(offDir), PASS), m.name, target, { passphrase: PASS });
    expect(done.manifest.name).toBe(m.name);
    expect(statSync(join(target, "forge.db")).size).toBeGreaterThan(0);
    // Another passphrase is refused at the header, and the bytes there do not open under it.
    await expect(sealedStore(dirStore(offDir), "wrong").get(`${SNAPSHOT_PREFIX}${m.name}/manifest.json`)).rejects.toThrow("does not open the lane");
    const header = parseHeader(readFileSync(join(offDir, LANE_HEADER)));
    if (typeof header === "string") throw new Error(header);
    const sealedFile = onBucket.find((f) => relative(offDir, f) !== LANE_HEADER)!;
    const wrong = await sealKeys("wrong", header.salt);
    expect(() => openBody(wrong, readFileSync(sealedFile), "x")).toThrow("wrong passphrase");

    // The drill restores the newest off-site snapshot, green, and keeps where it came from.
    const d = await svc.drill();
    expect(d.verdict).toBe("green");
    expect(d.snapshotId).toBe(m.name);
    expect(d.from).toBe(mirror.where);
    const kept = lastDrill(app.db);
    expect(kept?.from).toBe(mirror.where);
    expect(kept?.verdict).toBe("green");
    await svc.stop();
  }, 60_000);

  test("/system's section says when the lane last succeeded and what the drill restored from", () => {
    const lane = offsiteLane(lastMirror(app.config.dataDir), lastDrill(app.db), Date.now());
    expect(lane.health).toBe("ok");
    const out = String(offsiteSection(lane));
    expect(out).toContain('id="sys-offsite"');
    expect(out).toContain('data-health="ok"');
    expect(out).toContain('data-sealed="true"');
    expect(out).toContain(`data-success="${lane.lastSuccess}"`);
    expect(out).toContain("Last success");
    expect(out).toContain('data-drill="green"');
  });

  test("the terminal screen and the MCP read say what /system says, to a forge admin alone", async () => {
    const lane = readOffsiteLane(app.config.dataDir, app.db);
    const ident = (u: Awaited<ReturnType<typeof person>>) => ({ sshUsername: u.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: u });
    const admin = await person("lane-keeper", true);
    const member = await person("lane-reader", false);
    const lines = offsiteLines(new Session(app, ident(admin)));
    expect(lines[0]).toBe("The off-site lane is level and sealed.");
    expect(lines.join("\n")).toContain(`Writes to     ${lane.where!}`);
    expect(lines.join("\n")).toContain(`Last success  ${lane.lastSuccess!}`);
    expect(lines.join("\n")).toContain(`From          ${lane.drill!.from!} (off-site)`);
    expect(offsiteLines(new Session(app, ident(member)))).toEqual([]);

    const read = await systemTool.run({ app } as never, admin, { kind: "offsite" });
    expect(JSON.stringify(read)).toContain(`"lastSuccess":"${lane.lastSuccess!}"`);
    expect(JSON.stringify(read)).toContain('"says":"The off-site lane is level and sealed."');
    expect(JSON.stringify(await systemTool.run({ app } as never, member, { kind: "offsite" }))).toContain("forbidden");
  });

  test("a mirror pass that never ends holds a drill no longer than the drill's wait", async () => {
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const stuck: Store = { ...dirStore(join(root, "stuck")), where: "stuck", names: async () => (await held, []) };
    let drilled = false;
    const svc = startSnapshots(app, dirStore(join(root, "primary")), {
      version: "t",
      nightly: false,
      mirror: stuck,
      drillWaitMs: 50,
      drill: async (): Promise<DrillResult> => {
        drilled = true;
        return { at: new Date().toISOString(), snapshotId: null, ms: 0, counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 }, health: "ok", verdict: "green", failedStep: null, phases: [], budgetMs: 0, reason: null };
      },
    });
    const pass = svc.mirrorFresh();
    const started = performance.now();
    await svc.drill();
    expect(drilled).toBe(true);
    expect(performance.now() - started).toBeLessThan(5_000);
    release();
    await pass;
    await svc.stop();
  });

  async function person(username: string, isAdmin: boolean) {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", isAdmin });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  }
});

describe("answersRoot", () => {
  test("a restored forge's / answers below 400, a redirect included; a 5xx is red", async () => {
    const statuses: Record<string, number> = { "/ok/": 200, "/moved/": 302, "/broken/": 500 };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        const status = statuses[new URL(req.url).pathname] ?? 404;
        return new Response("", { status, headers: status === 302 ? { location: "/signin" } : {} });
      },
    });
    try {
      const base = `http://127.0.0.1:${String(server.port)}`;
      await answersRoot(`${base}/ok`);
      await answersRoot(`${base}/moved`);
      await expect(answersRoot(`${base}/broken`)).rejects.toThrow("answered / with 500");
    } finally {
      await server.stop(true);
    }
  });
});

describe("the lane's health", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const base = { where: "b2.example.com/offsite (sealed)", attemptAt: "2026-11-12T11:00:00Z", reachable: true };
  test("none, ok, unsealed, late and failing", () => {
    expect(offsiteLane(undefined, undefined, now).health).toBe("none");
    expect(offsiteLane({ ...base, sealed: true, syncedAt: "2026-11-12T11:00:00Z" }, undefined, now).health).toBe("ok");
    expect(offsiteLane({ ...base, sealed: false, syncedAt: "2026-11-12T11:00:00Z" }, undefined, now).health).toBe("unsealed");
    expect(offsiteLane({ ...base, sealed: true, syncedAt: "2026-11-10T11:00:00Z" }, undefined, now).health).toBe("late");
    const failing = offsiteLane({ ...base, sealed: true, failingSince: "2026-11-12T10:00:00Z", error: "refused" }, undefined, now);
    expect(failing.health).toBe("failing");
    expect(String(offsiteSection(failing))).toContain("The off-site lane is failing: refused.");
  });
});

describe("FOOTING", () => {
  test("no backup piece is on pg-grand", () => {
    const backup = FOOTING.filter((p) => p.need === "backup");
    expect(backup.length).toBeGreaterThan(0);
    expect(backup.every((p) => p.machine !== "pg-grand")).toBe(true);
    expect(backup.map((p) => p.machine).sort()).toEqual(["off-site", "vxrail"]);
  });
});
