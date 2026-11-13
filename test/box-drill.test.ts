/** scripts/box-drill.sh, driven against stub `systemctl`, `curl`, `id` and `uptime` on PATH. */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts/box-drill.sh");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A bin dir whose systemctl reports the pid in $STATE/pid, and a new one once that process is gone. */
function stubs(opts: { enabled?: string; curlCode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "box-drill-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  put(
    "systemctl",
    `case "$1" in
  is-enabled) echo ${opts.enabled ?? "enabled"} ;;
  is-active) exit 0 ;;
  show)
    case "$3" in
      ActiveEnterTimestampMonotonic) echo 12345678 ;;
      MainPID)
        p="$(cat "${dir}/pid")"
        # gone, or a zombie nobody has reaped yet: either way, systemd would have restarted it
        if [ "$p" != 4242 ] && { ! kill -0 "$p" 2>/dev/null || grep -q ') Z ' "/proc/$p/stat" 2>/dev/null; }; then echo 4242 > "${dir}/pid"; p=4242; fi
        echo "$p" ;;
    esac ;;
esac`,
  );
  put("curl", `echo -n ${opts.curlCode ?? "200"}`);
  put("id", "echo 0");
  put("uptime", "echo 2026-11-12 10:00:00");
  return { dir, env: { ...process.env, PORT: undefined, PATH: `${bin}:${process.env.PATH}`, DRILL_LIMIT: "3" } };
}

function run(args: string[], env: Record<string, string | undefined>) {
  const r = Bun.spawnSync(["bash", script, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

test("the drill is executable and says how to use it", () => {
  expect(statSync(script).mode & 0o111).toBeGreaterThan(0);
  const r = run([], process.env);
  expect(r.code).toBe(2);
  expect(r.err).toContain("usage:");
});

test("kill: kills the forge, waits for a new process to answer /, and prints how long", () => {
  // An orphan, so whatever reaps orphans here clears it once it dies.
  const pid = Number(
    Bun.spawnSync(["sh", "-c", "sleep 60 >/dev/null 2>&1 & echo $!"]).stdout.toString().trim(),
  );
  const s = stubs();
  writeFileSync(join(s.dir, "pid"), String(pid));
  const r = run(["kill", "http://127.0.0.1:9/"], s.env);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`killed forge pid ${pid}`);
  expect(r.out).toMatch(/back: pid 4242 answers http:\/\/127\.0\.0\.1:9\/ \d+\.\ds after the kill/);
  const stat = (() => {
    try {
      return readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return "gone";
    }
  })();
  expect(stat === "gone" || stat.includes(") Z ")).toBe(true);
});

test("kill: fails when / never answers", () => {
  const s = stubs({ curlCode: "000" });
  writeFileSync(join(s.dir, "pid"), "4242");
  const r = run(["kill"], s.env);
  expect(r.code).toBe(1);
  expect(r.err).toContain("does not answer before the kill");
});

test("boot: the unit is enabled, active, and / answers; prints seconds after boot", () => {
  const s = stubs();
  writeFileSync(join(s.dir, "pid"), "4242");
  const r = run(["boot"], s.env);
  expect(r.code).toBe(0);
  expect(r.out).toContain("forge enabled, active 12.3s after boot, pid 4242 answers http://127.0.0.1:3000/");
});

test("boot: a unit not enabled at boot fails the drill", () => {
  const s = stubs({ enabled: "disabled" });
  writeFileSync(join(s.dir, "pid"), "4242");
  const r = run(["boot"], s.env);
  expect(r.code).toBe(1);
  expect(r.err).toContain("forge is disabled at boot");
});
