/** The box's systemd unit (`infra/forge-box/forge.service`) says what docs/EXTRACT.md step 3 says. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  expect(svc.get("ExecStart")).toEqual(["/usr/local/bin/bun run src/main.ts"]);
  expect(svc.get("WorkingDirectory")).toEqual(["/opt/forge"]);
  expect(svc.get("Restart")).toEqual(["always"]);
  expect(svc.get("Environment")).toContain("FORGE_DATA=/var/lib/forge");
  expect(svc.get("User")).toEqual(["forge"]);
});

test("the unit starts at boot and never gives up restarting", () => {
  expect(unit.get("Install")!.get("WantedBy")).toEqual(["multi-user.target"]);
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
