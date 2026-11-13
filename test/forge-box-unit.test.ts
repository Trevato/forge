/** The box's systemd unit (`infra/forge-box/forge.service`) says what docs/EXTRACT.md step 3 says. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function parse(text: string): Map<string, Map<string, string[]>> {
  const out = new Map<string, Map<string, string[]>>();
  let sec: Map<string, string[]> | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const h = line.match(/^\[(\w+)\]$/);
    if (h) {
      sec = new Map();
      out.set(h[1]!, sec);
      continue;
    }
    const kv = line.match(/^(\w+)=(.*)$/);
    if (!kv || !sec) throw new Error(`unparsable unit line: ${line}`);
    sec.set(kv[1]!, [...(sec.get(kv[1]!) ?? []), kv[2]!]);
  }
  return out;
}

const unit = parse(readFileSync(join(root, "infra/forge-box/forge.service"), "utf8"));
const svc = unit.get("Service")!;

test("the unit runs the forge from /opt/forge and always restarts", () => {
  expect(svc.get("ExecStart")).toEqual(["/usr/local/bin/bun run src/release/launch.ts"]);
  expect(svc.get("WorkingDirectory")).toEqual(["/opt/forge"]);
  expect(svc.get("Restart")).toEqual(["always"]);
  expect(svc.get("Environment")).toContain("FORGE_DATA=/var/lib/forge");
  expect(svc.get("User")).toEqual(["forge"]);
});

test("the unit starts at boot and never gives up restarting", () => {
  expect(unit.get("Install")!.get("WantedBy")).toEqual(["multi-user.target"]);
  const restartSec = Number(svc.get("RestartSec")?.[0]);
  expect(restartSec).toBeGreaterThanOrEqual(1);
  expect(restartSec).toBeLessThanOrEqual(10);
  expect(unit.get("Unit")!.get("StartLimitIntervalSec")).toEqual(["0"]);
});

test("the install script places the unit, keeps no secret, and is executable", () => {
  const path = join(root, "scripts/box-install.sh");
  const sh = readFileSync(path, "utf8");
  expect(sh).toContain("/etc/systemd/system/forge.service");
  expect(sh).toContain("infra/forge-box/forge.service");
  expect(sh).toContain("set -euo pipefail");
  expect(sh).not.toMatch(/PASSPHRASE=\S/);
  expect(require("node:fs").statSync(path).mode & 0o111).toBeGreaterThan(0);
});

test("the unit delegates the cgroup and keeps cells to the allow-list", () => {
  expect(svc.get("Delegate")).toEqual(["yes"]);
  expect(svc.get("Environment")).toContain("FORGE_CELL_MOUNTS=allow-list");
});

test("the install script checks the tools, sets the sysctl and takes the pod's uid", () => {
  const sh = readFileSync(join(root, "scripts/box-install.sh"), "utf8");
  for (const b of ["bwrap", "chromium", "socat", "bun", "git"]) expect(sh).toContain(b);
  expect(sh).toContain("net.ipv4.tcp_migrate_req=1");
  expect(sh).toContain("/etc/sysctl.d/90-forge.conf");
  expect(sh).toContain('--uid "$uid"');
});

test("the tunnel unit is installed, never enabled, and routes every host to :3000", () => {
  const t = parse(readFileSync(join(root, "infra/forge-box/cloudflared-forge.service"), "utf8"));
  expect(t.get("Service")!.get("ExecStart")![0]).toContain("/etc/forge/cloudflared.yml");
  const sh = readFileSync(join(root, "scripts/box-install.sh"), "utf8");
  expect(sh).not.toMatch(/systemctl (enable|start)[^"\n]*cloudflared/);
  const yml = readFileSync(join(root, "infra/forge-box/cloudflared-forge.yml"), "utf8");
  for (const h of ["forge.open-platform.sh", "*--forge.open-platform.sh", "*--forge-trevato-apps.open-platform.sh"]) {
    expect(yml).toContain(`hostname: ${h.startsWith("*") ? `"${h}"` : h}`);
  }
  expect(yml).not.toMatch(/service: http:\/\/(?!127\.0\.0\.1:3000)/);
});

test("the GitHub mirror is a timer running a oneshot", () => {
  const dir = join(root, "infra/forge-box");
  const timer = parse(readFileSync(join(dir, "forge-github-mirror.timer"), "utf8"));
  expect(timer.get("Install")!.get("WantedBy")).toEqual(["timers.target"]);
  expect(timer.get("Timer")!.get("OnUnitActiveSec")).toBeDefined();
  const s = parse(readFileSync(join(dir, "forge-github-mirror.service"), "utf8"));
  expect(s.get("Service")!.get("Type")).toEqual(["oneshot"]);
});

test("both scripts parse under bash -n", () => {
  for (const f of ["scripts/box-install.sh", "infra/forge-box/github-mirror.sh"]) {
    const r = Bun.spawnSync(["bash", "-n", join(root, f)]);
    expect(r.exitCode).toBe(0);
  }
});

test("the mirror service's ExecStart is an executable file of this repository", () => {
  const s = parse(readFileSync(join(root, "infra/forge-box/forge-github-mirror.service"), "utf8"));
  const exec = s.get("Service")!.get("ExecStart")![0]!;
  expect(exec.startsWith("/opt/forge/")).toBe(true);
  const path = join(root, exec.slice("/opt/forge/".length));
  expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
});

test("the unit's ports are defaults that forge.env may override, and the install script says so", () => {
  expect(svc.get("EnvironmentFile")).toEqual(["/etc/forge/forge.env"]);
  expect(readFileSync(join(root, "scripts/box-install.sh"), "utf8")).toContain("# FORGE_SSH_PORT=2222");
});

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}

function mirror(data: string) {
  const r = Bun.spawnSync(["bash", join(root, "infra/forge-box/github-mirror.sh")], {
    env: { ...process.env, FORGE_DATA: data },
    stderr: "pipe",
    stdout: "pipe",
  });
  return { code: r.exitCode, err: r.stderr.toString() };
}

test("github-mirror.sh pushes branches and tags, is a no-op twice, skips repos without the remote, fails loudly, never deletes", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  try {
    const bare = join(dir, "repos/o/a.git");
    const plain = join(dir, "repos/o/b.git");
    const remote = join(dir, "remote.git");
    for (const p of [bare, plain, remote]) git(dir, "init", "-q", "--bare", "-b", "main", p);
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
    git(work, "tag", "v1");
    git(work, "push", "-q", bare, "main", "v1");
    git(work, "push", "-q", plain, "main");
    git(bare, "remote", "add", "github", remote);

    expect(mirror(dir).code).toBe(0);
    expect(git(remote, "rev-parse", "main").out).toBe(git(bare, "rev-parse", "main").out);
    expect(git(remote, "tag").out).toBe("v1");
    expect(mirror(dir).code).toBe(0); // second push changes nothing
    expect(git(remote, "rev-parse", "main").out).toBe(git(bare, "rev-parse", "main").out);
    expect(git(plain, "remote").out).toBe(""); // skipped, untouched

    // a ref only the remote has is never deleted
    git(work, "push", "-q", remote, "main:extra");
    expect(mirror(dir).code).toBe(0);
    expect(git(remote, "rev-parse", "extra").code).toBe(0);

    // a remote that cannot be reached fails non-zero
    git(bare, "remote", "set-url", "github", join(dir, "gone.git"));
    const bad = mirror(dir);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("mirror failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
