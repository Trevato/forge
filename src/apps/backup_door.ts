/**
 * What the terminal's "Back up data" screen does for one app: seal its
 * production data under the owner's passphrase into `<data>/app-backups/<appId>/`,
 * list what is there, and prove one file. The work runs in a child process
 * (`src/apps/backup_cli.ts`, the code behind `scripts/app-backup.ts`), so the forge's event loop stays free; the
 * passphrase goes to it in the environment, never in argv, and is never
 * stored, logged or returned. A data directory over `SEAL_CAP_BYTES` is
 * refused before a byte of it is read: the archive is held whole in memory.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Proof } from "./backup.ts";
import { envDataDir } from "./data.ts";

export const SEAL_CAP_BYTES = 64 * 1024 * 1024;
const SCRIPT = new URL("./backup_cli.ts", import.meta.url).pathname;
const CHILD_TIMEOUT_MS = 10 * 60_000;

const dirFor = (dataDir: string, appId: string): string => join(dataDir, "app-backups", appId);

export interface BackupFile {
  name: string;
  bytes: number;
  at: string;
}

export function listBackups(dataDir: string, appId: string): BackupFile[] {
  const d = dirFor(dataDir, appId);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((n) => /^production-[0-9TZ-]+\.fab$/.test(n))
    .sort()
    .reverse()
    .map((name) => {
      const st = statSync(join(d, name));
      return { name, bytes: st.size, at: st.mtime.toISOString() };
    });
}

/** Total bytes of the regular files under `dir`, stopping as soon as it passes `cap`. Sizes only: nothing is read. */
export function bytesUnder(dir: string, cap: number): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= cap) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) total += lstatSync(p).size;
      if (total > cap) break;
    }
  }
  return total;
}

const isProof = (v: unknown): v is Proof => {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p["ok"] === "boolean" &&
    ["files", "bytes", "tables", "rows"].every((k) => typeof p[k] === "number") &&
    Array.isArray(p["problems"]) &&
    (p["problems"] as unknown[]).every((x) => typeof x === "string")
  );
};

/** Run the script with the passphrase in env; its last stdout line is the proof as JSON, its stderr the refusal. */
async function runScript(args: string[], passphrase: string): Promise<Proof | string> {
  try {
    const child = Bun.spawn([process.execPath, SCRIPT, ...args, "--json"], {
      env: { PATH: process.env["PATH"] ?? "", TMPDIR: process.env["TMPDIR"] ?? tmpdir(), APP_BACKUP_PASSPHRASE: passphrase },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: CHILD_TIMEOUT_MS,
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const last = out.trim().split("\n").pop() ?? "";
    try {
      const parsed: unknown = JSON.parse(last);
      if (isProof(parsed)) return parsed;
    } catch {
      // not a proof line: the refusal is on stderr
    }
    const why = err.trim().split("\n").pop()?.replace(/^app-backup: /, "") ?? "";
    return why === "" ? "the backup did not finish" : why;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function sealApp(dataDir: string, appId: string, passphrase: string, now = new Date()): Promise<Proof | string> {
  try {
    const src = envDataDir(dataDir, appId, "production");
    if (!existsSync(src)) return "this app has no production data yet";
    if (bytesUnder(src, SEAL_CAP_BYTES) > SEAL_CAP_BYTES) {
      return `the data directory is over ${SEAL_CAP_BYTES / (1024 * 1024)} MB: back it up with scripts/app-backup.ts on the host`;
    }
    const d = dirFor(dataDir, appId);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    return await runScript(["seal", src, join(d, `production-${stamp}.fab`)], passphrase);
  } catch (e) {
    return (e as Error).message;
  }
}

export async function proveApp(dataDir: string, appId: string, name: string, passphrase: string): Promise<Proof | string> {
  let scratch: string | undefined;
  try {
    const at = listBackups(dataDir, appId).find((b) => b.name === name);
    if (at === undefined) return "no such backup";
    if (at.bytes > SEAL_CAP_BYTES * 2) return "this backup is too large to prove here: use scripts/app-backup.ts on the host";
    scratch = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "app-prove-"));
    return await runScript(["prove", join(dirFor(dataDir, appId), name), join(scratch, "restore")], passphrase);
  } catch (e) {
    return (e as Error).message;
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
