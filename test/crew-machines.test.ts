import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare } from "../src/apps/cgroup.ts";
import { cellPlan, openRunCell } from "../src/crew/run-cell.ts";
import {
  BUILT_IN,
  machineEnv,
  machineFor,
  machineLimits,
  machineNote,
  NO_CONFIG,
  parseMachines,
  reachableApps,
  SECURITY,
  STANDARD,
  TOOLS,
} from "../src/crew/machines.ts";

const config = (root: unknown) => {
  const parsed = parseMachines(JSON.stringify(root));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const refusal = (root: unknown) => {
  const parsed = parseMachines(JSON.stringify(root));
  return parsed.ok ? undefined : parsed.error;
};

describe("machines", () => {
  test("no forge.json, or none that declares machines, is the built-ins", () => {
    expect(parseMachines(undefined)).toEqual({ ok: true, value: NO_CONFIG });
    expect(config({ app: {} }).machines).toEqual(BUILT_IN);
    expect(parseMachines("{not json")).toEqual({ ok: true, value: NO_CONFIG });
  });

  test("a role with no choice runs in the standard machine, which is today's sandbox", () => {
    expect(machineFor(NO_CONFIG, "reviewer")).toBe(STANDARD);
    expect(machineFor(NO_CONFIG, undefined)).toBe(STANDARD);
    expect(STANDARD.tools).toEqual([]);
    expect(STANDARD.reach).toEqual(["apps"]);
  });

  test("a repository picks a machine for a role from the list", () => {
    const c = config({
      machines: { audit: { tools: ["gitleaks", "gitleaks", "nmap"], reach: [] } },
      machineFor: { reviewer: "audit", planner: "security" },
    });
    const audit = machineFor(c, "reviewer");
    expect(audit.name).toBe("audit");
    expect(audit.tools).toEqual(["gitleaks", "nmap"]);
    expect(audit.reach).toEqual([]);
    expect(machineFor(c, "planner")).toBe(SECURITY);
    expect(machineFor(c, "builder")).toBe(STANDARD);
  });

  test("the security machine ships with the investigation tools from the research", () => {
    expect([...SECURITY.tools].sort()).toEqual(
      ["gitleaks", "trivy", "osv-scanner", "nuclei", "zap", "testssl.sh", "nmap"].sort(),
    );
    for (const tool of SECURITY.tools) expect(TOOLS[tool]).toBeTruthy();
  });

  test("a machine cannot name a host, a tool off the list, or a role that is not one", () => {
    expect(refusal({ machines: { a: { reach: ["evil.example.com"] } } })).toContain("cannot name a host");
    expect(refusal({ machines: { a: { reach: ["forge"] } } })).toContain("reach");
    expect(refusal({ machines: { a: { tools: ["rm -rf /"] } } })).toContain("pick from");
    expect(refusal({ machines: { a: { tools: ["__proto__"] } } })).toContain("pick from");
    expect(refusal({ machines: { "A b": {} } })).toContain("lowercase");
    expect(refusal({ machines: [] })).toContain("object");
    expect(refusal({ machineFor: { admin: "standard" } })).toContain("not a crew role");
    expect(refusal({ machineFor: { builder: "nope" } })).toContain("not declared");
  });

  test("reach only ever narrows the app URLs the sandbox allows", () => {
    const urls = ["https://notes.example", "https://notes--3.example"];
    expect(reachableApps(STANDARD, urls)).toEqual(urls);
    const closed = config({ machines: { shut: { reach: [] } } }).machines.find((m) => m.name === "shut")!;
    expect(reachableApps(closed, urls)).toEqual([]);
  });

  test("a machine's environment carries names, never a secret", () => {
    expect(machineEnv(SECURITY).FORGE_MACHINE).toBe("security");
    expect(machineEnv(SECURITY).FORGE_MACHINE_TOOLS).toContain("gitleaks");
    expect(Object.keys(machineEnv(SECURITY)).sort()).toEqual(["FORGE_MACHINE", "FORGE_MACHINE_TOOLS"]);
  });

  test("the brief names the tools a machine carries, and says nothing for the standard one", () => {
    expect(machineNote(STANDARD)).toBeUndefined();
    expect(machineNote(SECURITY)).toContain("gitleaks");
    expect(machineNote(SECURITY)).toContain("forge's own copies");
  });
});

describe("a machine's memory and CPU ceilings (#9469)", () => {
  test("memory (whole MiB) and cpus (cores) parse within bounds", () => {
    const c = config({ machines: { big: { memory: 2048, cpus: 1.5 } }, machineFor: { builder: "big" } });
    const big = machineFor(c, "builder");
    expect(big.memoryMiB).toBe(2048);
    expect(big.cpus).toBe(1.5);
    expect(machineLimits(big)).toEqual({ memoryMiB: 2048, cpus: 1.5 });
  });

  test("an out-of-bounds or ill-typed ceiling is refused, so the crew runs in standard", () => {
    for (const bad of [{ memory: 64 }, { memory: 1e6 }, { memory: 512.5 }, { memory: "2G" }, { cpus: 0 }, { cpus: 0.1 }, { cpus: 65 }, { cpus: "2" }])
      expect(refusal({ machines: { m: bad } })).toMatch(/machines\.m\.(memory|cpus)/);
  });

  test("standard declares no ceiling: today's run exactly", () => {
    expect(machineLimits(STANDARD)).toEqual({});
    expect(machineLimits(SECURITY)).toEqual({});
    expect(cellPlan({}, 4)).toEqual({ memoryMiB: undefined, cpus: 4 });
  });

  test("a machine only narrows the forge's own cores", () => {
    expect(cellPlan({ cpus: 2 }, 4).cpus).toBe(2);
    expect(cellPlan({ cpus: 16 }, 4).cpus).toBe(4);
  });
});

describe("a crew run's cell holds its machine's ceilings", () => {
  const root = mkdtempSync(join(tmpdir(), "run-cell-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;
  const host = () => {
    const dir = join(root, `h${n++}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "cgroup.controllers"), "cpu io memory\n");
    writeFileSync(join(dir, "cgroup.procs"), "");
    writeFileSync(join(dir, "cgroup.subtree_control"), "");
    return prepare({ ok: true, root: dir });
  };

  test("declared ceilings land in the cell's cgroup, the run enters it strictly, and the log says so", () => {
    const lines: string[] = [];
    const cell = openRunCell({ memoryMiB: 1024, cpus: 2 }, host(), 4, (l) => lines.push(l));
    const dir = cell.cgroup!.dir;
    expect(readFileSync(join(dir, "memory.max"), "utf8")).toBe(String(1024 * 1024 * 1024));
    expect(readFileSync(join(dir, "cpu.max"), "utf8")).toBe("200000 100000");
    const argv = cell.wrap(["claude", "-p"]);
    expect(argv).toContain(join(dir, "cgroup.procs"));
    expect(argv.slice(-2)).toEqual(["claude", "-p"]);
    // Strict: a run made for a cap refuses to start outside it.
    expect(argv[2]).toContain("exit 125");
    expect(lines).toEqual(["machine: held to memory 1024 MiB and 2 CPUs"]);
    cell.cgroup!.remove();
  });

  test("standard's cell is today's: no memory cap, the crew's cores, best-effort entry, nothing logged", () => {
    const lines: string[] = [];
    const cell = openRunCell({}, host(), 4, (l) => lines.push(l));
    expect(existsSync(join(cell.cgroup!.dir, "memory.max"))).toBe(false);
    expect(readFileSync(join(cell.cgroup!.dir, "cpu.max"), "utf8")).toBe("400000 100000");
    expect(cell.wrap(["claude"])[2]).not.toContain("exit 125");
    expect(lines).toEqual([]);
    cell.cgroup!.remove();
  });

  test("a host that cannot hold a ceiling says so in one line, and the run goes as before", () => {
    const lines: string[] = [];
    const cell = openRunCell({ memoryMiB: 512 }, { ok: false, reason: "no cgroup v2 here" }, 4, (l) => lines.push(l));
    expect(cell.cgroup).toBeUndefined();
    expect(cell.wrap(["claude"])).toEqual(["claude"]);
    expect(lines).toEqual(["machine: memory 512 MiB not applied: no cgroup v2 here"]);
    const quiet: string[] = [];
    openRunCell({}, { ok: false, reason: "no cgroup v2 here" }, 4, (l) => quiet.push(l));
    expect(quiet).toEqual([]);
  });
});
