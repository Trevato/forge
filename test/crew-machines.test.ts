import { describe, expect, test } from "bun:test";
import {
  BUILT_IN,
  machineEnv,
  machineFor,
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
