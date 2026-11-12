/**
 * An app's own backup: its data directory sealed under a passphrase the
 * owner holds, and a restore that proves itself. The forge's snapshot
 * (`src/snapshot`) covers the forge; this covers one environment's
 * `FORGE_APP_DATA`, so an owner can keep a copy the forge's operator cannot
 * open and a person who moves an app off the forge can prove it came back.
 *
 * File format: `FAB1\n`, one JSON header line (`v`, `kdf`, `salt`, `iv`,
 * base64url), then AES-256-GCM ciphertext ending in its 16-byte tag. The
 * key is scrypt of the passphrase; the header is authenticated. Inside is a
 * manifest (every file's path, size, SHA-256, and every SQLite table's row
 * count) followed by the file bytes. Whole-archive in memory: meant for
 * app data of tens of megabytes, not gigabytes (`docs/features/app-backup.md`).
 */

import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { quiesceSqlite } from "./data.ts";

const MAGIC = "FAB1\n";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const MIN_PASSPHRASE = 12;

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
}
export interface Manifest {
  files: FileEntry[];
  /** SQLite file path → table → row count, at the moment of the backup. */
  tables: Record<string, Record<string, number>>;
  /** Entries the walk could not archive (symlinks, devices, sockets): never silently dropped. */
  skipped?: string[];
}
export interface Proof {
  ok: boolean;
  files: number;
  bytes: number;
  tables: number;
  rows: number;
  /** What did not match; empty when ok. */
  problems: string[];
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function passphraseProblem(p: string | undefined): string | undefined {
  if (p === undefined || p === "") return "no passphrase: set APP_BACKUP_PASSPHRASE";
  if (p.length < MIN_PASSPHRASE) return `the passphrase is under ${MIN_PASSPHRASE} characters`;
  return undefined;
}

function walk(root: string, rel = "", out: string[] = [], skipped: string[] = []): { files: string[]; skipped: string[] } {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, r, out, skipped);
    else if (/-(wal|shm)$/.test(e.name)) continue; // emptied by the checkpoint
    else if (e.isFile()) out.push(r);
    else skipped.push(r);
  }
  return { files: out.sort(), skipped: skipped.sort() };
}

const isSqlite = (bytes: Uint8Array): boolean =>
  bytes.length >= 16 && Buffer.from(bytes.subarray(0, 16)).toString("latin1") === "SQLite format 3\0";

/** Row counts for every table of a SQLite file, read-only; `undefined` if it will not open. */
export function tableCounts(path: string): Record<string, number> | undefined {
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const counts: Record<string, number> = {};
    for (const { name } of names) {
      const row = db.query(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get() as { n: number };
      counts[name] = row.n;
    }
    return counts;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** Seal a data directory. Throws a message (not a bug) for an unusable passphrase or directory. */
export function sealWithManifest(dir: string, passphrase: string): { sealed: Buffer; manifest: Manifest } {
  const bad = passphraseProblem(passphrase);
  if (bad !== undefined) throw new Error(bad);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new Error("the data directory does not exist");
  quiesceSqlite(dir);
  const found = walk(dir);
  const manifest: Manifest = { files: [], tables: {}, skipped: found.skipped };
  const bodies: Buffer[] = [];
  for (const path of found.files) {
    const bytes = readFileSync(join(dir, path));
    manifest.files.push({ path, size: bytes.length, sha256: sha(bytes) });
    bodies.push(bytes);
    if (isSqlite(bytes)) {
      const counts = tableCounts(join(dir, path));
      if (counts !== undefined) manifest.tables[path] = counts;
    }
  }
  return { sealed: sealParts(manifest, bodies, passphrase), manifest };
}

/** Encrypt a manifest and its file bodies as given; `sealWithManifest` is the honest caller. */
export function sealParts(manifest: Manifest, bodies: Buffer[], passphrase: string): Buffer {
  const m = Buffer.from(JSON.stringify(manifest));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(m.length);
  const plain = Buffer.concat([len, m, ...bodies]);

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.from(
    `${JSON.stringify({ v: 1, kdf: "scrypt", salt: salt.toString("base64url"), iv: iv.toString("base64url") })}\n`,
  );
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv, { authTagLength: 16 });
  cipher.setAAD(header);
  return Buffer.concat([Buffer.from(MAGIC), header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** The manifest and file bytes, or a message: a wrong passphrase and a damaged file say the same thing. */
export function openBackup(sealed: Uint8Array, passphrase: string): { manifest: Manifest; bodies: Buffer[] } | string {
  const refuse = "cannot open this backup: wrong passphrase, or the file is damaged";
  try {
    const buf = Buffer.from(sealed);
    if (buf.subarray(0, MAGIC.length).toString("latin1") !== MAGIC) return "not an app backup file";
    const nl = buf.indexOf(10, MAGIC.length);
    if (nl < 0 || nl > 512 || buf.length < nl + 1 + 16) return refuse;
    const header = buf.subarray(MAGIC.length, nl + 1);
    const h = JSON.parse(header.toString()) as Record<string, unknown>;
    if (h["v"] !== 1 || h["kdf"] !== "scrypt") return refuse;
    const salt = Buffer.from(String(h["salt"]), "base64url");
    const iv = Buffer.from(String(h["iv"]), "base64url");
    if (salt.length !== 16 || iv.length !== 12) return refuse;
    const body = buf.subarray(nl + 1);
    const d = createDecipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv, { authTagLength: 16 });
    d.setAAD(header);
    d.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    const mlen = plain.readUInt32BE(0);
    const manifest = JSON.parse(plain.subarray(4, 4 + mlen).toString()) as Manifest;
    let at = 4 + mlen;
    const bodies: Buffer[] = [];
    for (const f of manifest.files) {
      bodies.push(plain.subarray(at, at + f.size));
      at += f.size;
    }
    return { manifest, bodies };
  } catch {
    return refuse;
  }
}

const safeRel = (p: string): boolean =>
  p !== "" && !p.startsWith("/") && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === "." || s === "");

/**
 * Restore a backup into `scratch` (must not exist or be empty) and prove it:
 * every file's SHA-256 and size read back from disk, every SQLite table's row
 * count read back from the restored database. Returns a message when it cannot
 * even try (wrong passphrase, scratch in use).
 */
export function restoreProof(sealed: Uint8Array, passphrase: string, scratch: string): Proof | string {
  const bad = passphraseProblem(passphrase);
  if (bad !== undefined) return bad;
  if (existsSync(scratch) && readdirSync(scratch).length > 0) return "the scratch directory is not empty";
  const opened = openBackup(sealed, passphrase);
  if (typeof opened === "string") return opened;
  const { manifest, bodies } = opened;
  const root = resolve(scratch);
  mkdirSync(root, { recursive: true });
  const problems: string[] = [];
  for (const k of manifest.skipped ?? [])
    problems.push(`${k}: not archived (a symlink or special file); the backup does not cover it`);
  let bytes = 0;
  manifest.files.forEach((f, i) => {
    const target = resolve(root, f.path);
    if (!safeRel(f.path) || !target.startsWith(root + sep)) {
      problems.push(`refused an unsafe path: ${JSON.stringify(f.path)}`);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bodies[i]!);
  });
  for (const f of manifest.files) {
    const target = resolve(root, f.path);
    if (!safeRel(f.path) || !target.startsWith(root + sep)) continue;
    const back = readFileSync(target);
    bytes += back.length;
    if (back.length !== f.size || sha(back) !== f.sha256) problems.push(`${f.path}: bytes differ from the backup's manifest`);
  }
  let tables = 0;
  let rows = 0;
  for (const [file, expected] of Object.entries(manifest.tables)) {
    if (!safeRel(file)) continue;
    const got = tableCounts(join(root, file));
    for (const [t, n] of Object.entries(expected)) {
      tables++;
      rows += n;
      if (got === undefined) problems.push(`${file}: restored database does not open`);
      else if (got[t] !== n) problems.push(`${file} ${t}: ${n} rows backed up, ${got[t] ?? "no table"} restored`);
    }
  }
  return { ok: problems.length === 0, files: manifest.files.length, bytes, tables, rows, problems };
}

/** The data directory against the manifest taken from it: what changed since, and what was left out. */
export function sourceDrift(dir: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  const now = walk(dir);
  const had = new Set(manifest.files.map((f) => f.path));
  for (const p of now.files) if (!had.has(p)) problems.push(`${p}: appeared in the data directory after the backup was read`);
  for (const f of manifest.files) {
    let back: Buffer;
    try {
      back = readFileSync(join(dir, f.path));
    } catch {
      problems.push(`${f.path}: gone from the data directory since the backup was read`);
      continue;
    }
    if (back.length !== f.size || sha(back) !== f.sha256) problems.push(`${f.path}: changed in the data directory since the backup was read`);
  }
  return problems;
}

/**
 * Seal `dir` into `out`, prove the result and the data left behind, and keep
 * the file only when both are clean: it is written under a temporary name in
 * the same directory and renamed on PROVEN, so a RED proof leaves no backup
 * that looks like one. Throws a message for unusable input.
 */
export function sealAndProve(dir: string, out: string, passphrase: string): Proof {
  const bad = passphraseProblem(passphrase);
  if (bad !== undefined) throw new Error(bad);
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new Error("the data directory does not exist");
  const outDir = realpathSync(dirname(resolve(out)));
  const target = join(outDir, basename(out));
  const root = realpathSync(dir);
  if (target === root || target.startsWith(root + sep)) throw new Error("the out-file is inside the data directory");
  const { sealed, manifest } = sealWithManifest(dir, passphrase);
  const part = join(outDir, `.${basename(out)}.${randomBytes(6).toString("hex")}.part`);
  const scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "app-backup-"));
  try {
    writeFileSync(part, sealed, { mode: 0o600 });
    const p = restoreProof(readFileSync(part), passphrase, join(scratch, "restore"));
    if (typeof p === "string") throw new Error(p);
    p.problems.push(...sourceDrift(dir, manifest));
    p.ok = p.problems.length === 0;
    if (p.ok) renameSync(part, target);
    return p;
  } finally {
    rmSync(part, { force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
