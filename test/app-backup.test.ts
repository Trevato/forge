import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBackup, restoreProof, sealAndProve, sealParts, sealWithManifest, sourceDrift as sourceDriftOf } from "../src/apps/backup.ts";
import { bytesUnder, listBackups, proveApp, SEAL_CAP_BYTES, sealApp } from "../src/apps/backup_door.ts";
import { envDataDir } from "../src/apps/data.ts";

const PASS = "correct horse battery";
const tmp = () => mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ab-"));

function app(): string {
  const d = tmp();
  const db = new Database(join(d, "app.db"));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE orders(id INTEGER PRIMARY KEY, n TEXT)");
  for (let i = 0; i < 7; i++) db.run("INSERT INTO orders(n) VALUES (?)", [`o${i}`]);
  mkdirSync(join(d, "uploads/a"), { recursive: true });
  writeFileSync(join(d, "uploads/a/x.txt"), "hello");
  return d; // db left open: the WAL holds writes, as in a running app
}

describe("app backup", () => {
  test("seals, restores and proves files and row counts", () => {
    const sealed = sealWithManifest(app(), PASS).sealed;
    const scratch = join(tmp(), "out");
    const p = restoreProof(sealed, PASS, scratch);
    expect(p).toMatchObject({ ok: true, files: 2, tables: 1, rows: 7 });
  });
  test("holds no plaintext", () => {
    const sealed = sealWithManifest(app(), PASS).sealed;
    expect(sealed.includes("hello")).toBe(false);
    expect(sealed.includes("SQLite format")).toBe(false);
  });
  test("wrong passphrase and tampering are refused alike, writing nothing", () => {
    const sealed = sealWithManifest(app(), PASS).sealed;
    const scratch = join(tmp(), "out");
    expect(restoreProof(sealed, "another passphrase!", scratch)).toMatch(/wrong passphrase/);
    const bent = Buffer.from(sealed);
    bent[bent.length - 20] = bent[bent.length - 20]! ^ 1;
    expect(restoreProof(bent, PASS, scratch)).toMatch(/wrong passphrase/);
    expect(openBackup(Buffer.from("junk"), PASS)).toBe("not an app backup file");
  });
  test("a short passphrase is refused up front", () => {
    expect(() => sealWithManifest(app(), "short")).toThrow(/under 12/);
  });
  test("refuses a scratch directory in use", () => {
    const sealed = sealWithManifest(app(), PASS).sealed;
    const busy = tmp();
    writeFileSync(join(busy, "keep"), "x");
    expect(restoreProof(sealed, PASS, busy)).toMatch(/not empty/);
    expect(readdirSync(busy)).toEqual(["keep"]);
  });
});

describe("the proof is against the manifest and the source", () => {
  test("bytes that disagree with the manifest are RED, with the problem named", () => {
    const d = app();
    const { manifest } = sealWithManifest(d, PASS);
    const bodies = manifest.files.map((f) => Buffer.alloc(f.size, 65));
    const p = restoreProof(sealParts(manifest, bodies, PASS), PASS, join(tmp(), "out"));
    expect(typeof p).toBe("object");
    if (typeof p === "string") return;
    expect(p.ok).toBe(false);
    expect(p.problems.some((m) => /bytes differ from the backup's manifest/.test(m))).toBe(true);
    expect(p.problems.some((m) => /app.db: restored database does not open/.test(m))).toBe(true);
  });
  test("an unsafe path in the manifest is refused and nothing is written outside", () => {
    const base = tmp();
    const m = {
      files: [
        { path: "../escape.txt", size: 1, sha256: "x" },
        { path: "/abs.txt", size: 1, sha256: "x" },
      ],
      tables: {},
    };
    const p = restoreProof(sealParts(m, [Buffer.from("a"), Buffer.from("b")], PASS), PASS, join(base, "out"));
    if (typeof p === "string") throw new Error(p);
    expect(p.ok).toBe(false);
    expect(p.problems.filter((x) => /unsafe path/.test(x)).length).toBe(2);
    expect(existsSync(join(base, "escape.txt"))).toBe(false);
    expect(existsSync("/abs.txt")).toBe(false);
  });
  test("a truncated file is refused", () => {
    const sealed = sealWithManifest(app(), PASS).sealed;
    const scratch = join(tmp(), "out");
    expect(restoreProof(sealed.subarray(0, sealed.length - 30), PASS, scratch)).toMatch(/wrong passphrase/);
    expect(restoreProof(sealed.subarray(0, 40), PASS, scratch)).toMatch(/wrong passphrase|not an app/);
    expect(existsSync(scratch)).toBe(false);
  });
  test("a symlink is reported, not silently dropped, and the proof is RED", () => {
    const d = app();
    symlinkSync("/etc/hostname", join(d, "link"));
    const { manifest } = sealWithManifest(d, PASS);
    expect(manifest.skipped).toEqual(["link"]);
    const p = restoreProof(sealWithManifest(d, PASS).sealed, PASS, join(tmp(), "out"));
    if (typeof p === "string") throw new Error(p);
    expect(p.ok).toBe(false);
    expect(p.problems[0]).toMatch(/^link: not archived/);
  });
  test("sealAndProve: out-file kept on PROVEN, absent on RED, refused inside the data dir", () => {
    const d = app();
    const out = join(tmp(), "ok.fab");
    expect(sealAndProve(d, out, PASS).ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    const outDir = tmp();
    symlinkSync("/etc/hostname", join(d, "link"));
    const red = sealAndProve(d, join(outDir, "red.fab"), PASS);
    expect(red.ok).toBe(false);
    expect(readdirSync(outDir)).toEqual([]);
    expect(() => sealAndProve(d, join(d, "uploads", "in.fab"), PASS)).toThrow(/inside the data directory/);
  });
  test("a source changed after the read is RED", () => {
    const d = app();
    const m = sealWithManifest(d, PASS).manifest;
    writeFileSync(join(d, "uploads/a/x.txt"), "changed!");
    expect(sourceDriftOf(d, m)).toEqual(["uploads/a/x.txt: changed in the data directory since the backup was read"]);
  });
});

describe("scripts/app-backup.ts", () => {
  test("prove restores a sealed file and exits 0; a wrong passphrase exits 1", async () => {
    const out = join(tmp(), "b.fab");
    writeFileSync(out, sealWithManifest(app(), PASS).sealed);
    const run = async (pass: string, scratch: string) => {
      const p = Bun.spawn(["bun", "scripts/app-backup.ts", "prove", out, scratch], {
        env: { PATH: process.env["PATH"] ?? "", TMPDIR: process.env["TMPDIR"] ?? tmpdir(), APP_BACKUP_PASSPHRASE: pass },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
    };
    const ok = await run(PASS, join(tmp(), "r"));
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^PROVEN: 2 files/);
    const bad = await run("not the passphrase!", join(tmp(), "r2"));
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/wrong passphrase/);
  });
  test("seal writes the file and exits 0 with PROVEN; no passphrase exits 1", async () => {
    const d = app();
    const out = join(tmp(), "b.fab");
    const run = async (env: Record<string, string>) => {
      const p = Bun.spawn(["bun", "scripts/app-backup.ts", "seal", d, out], {
        env: { PATH: process.env["PATH"] ?? "", TMPDIR: process.env["TMPDIR"] ?? tmpdir(), ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
    };
    const ok = await run({ APP_BACKUP_PASSPHRASE: PASS });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^PROVEN: 2 files/);
    const none = await run({});
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/no passphrase/);
  });
});

describe("src/apps/backup_door.ts", () => {
  const appData = (forge: string, appId: string): string => {
    const d = envDataDir(forge, appId, "production");
    mkdirSync(d, { recursive: true });
    return d;
  };
  test("a data directory over the cap is refused before it is read, and nothing is written", async () => {
    const forge = tmp();
    const d = appData(forge, "big");
    mkdirSync(join(d, "deep"), { recursive: true });
    writeFileSync(join(d, "deep", "huge.bin"), "");
    truncateSync(join(d, "deep", "huge.bin"), SEAL_CAP_BYTES + 1); // sparse: no bytes on disk
    expect(bytesUnder(d, SEAL_CAP_BYTES)).toBeGreaterThan(SEAL_CAP_BYTES);
    const r = await sealApp(forge, "big", PASS);
    expect(r).toMatch(/over 64 MB/);
    expect(listBackups(forge, "big")).toEqual([]);
  });
  test("under the cap it seals in a child process and proves", async () => {
    const forge = tmp();
    writeFileSync(join(appData(forge, "small"), "x.txt"), "hello");
    const r = await sealApp(forge, "small", PASS);
    expect(typeof r === "string" ? r : r.ok).toBe(true);
    const [b] = listBackups(forge, "small");
    const p = await proveApp(forge, "small", b!.name, PASS);
    expect(typeof p === "string" ? p : p.files).toBe(1);
    expect(await proveApp(forge, "small", b!.name, "the wrong passphrase")).toMatch(/wrong passphrase/);
  });
  test("prove answers a message, never a rejection, for a backup that will not open", async () => {
    const forge = tmp();
    const d = join(forge, "app-backups", "bad");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "production-2026-01-01T00-00-00-000Z.fab"), "FAB1\nnot json\n");
    expect(typeof (await proveApp(forge, "bad", "production-2026-01-01T00-00-00-000Z.fab", PASS))).toBe("string");
    expect(await proveApp(forge, "bad", "../../etc/passwd", PASS)).toBe("no such backup");
  });
});
