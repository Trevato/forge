/**
 * Machines (#9418): the named configuration a crew member's shell runs in.
 * A machine says which investigation tools its role is given, what it may
 * use up, and how far it may reach. It can only narrow the sandbox
 * (`crew/sandbox.ts`), never widen it: reach is a choice between names the
 * forge owns (`apps`), not a host list, so no machine configuration
 * can name a system the forge does not own, and the forge's secrets stay
 * denied by the sandbox whatever a machine says.
 *
 * A repository declares machines at the top level of `forge.json`, read at
 * the default branch's tip, never from the agent's own branch (an agent
 * cannot hand itself a bigger machine):
 *
 *   "machines": { "audit": { "tools": ["gitleaks"], "reach": [] } },
 *   "machineFor": { "reviewer": "audit" }
 *
 * `standard` (today's sandbox) and `security` ship built in. Pure: text in,
 * plain data out.
 */

import { CREW_ROLES, type CrewRole } from "../core/agents.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/**
 * What a machine may reach beyond the forge itself (always reachable: the
 * shell pushes and reads through it): the repository's own app, production
 * and previews. A machine can drop it; it cannot add anything.
 */
export const REACHES = ["apps"] as const;
export type Reach = (typeof REACHES)[number];

/**
 * The tools a machine can be given, from a list (not free text, so a name
 * is never a command). The security machine's first set, from the research
 * on #9418; they investigate the forge's own copies only.
 */
export const TOOLS: Readonly<Record<string, string>> = {
  gitleaks: "finds secrets committed to a repository",
  trivy: "scans dependencies and images for known vulnerabilities",
  "osv-scanner": "matches lockfiles against the OSV vulnerability database",
  nuclei: "runs template-driven checks against a running app",
  zap: "probes a running web app for common weaknesses",
  "testssl.sh": "checks a TLS endpoint's protocols and ciphers",
  nmap: "maps open ports on a host the machine may reach",
};

export interface Machine {
  readonly name: string;
  readonly label: string;
  readonly tools: readonly string[];
  readonly reach: readonly Reach[];
}

/** Today's sandbox, unchanged: the forge and the repository's own app. */
export const STANDARD: Machine = {
  name: "standard",
  label: "Standard — the crew's usual sandbox",
  tools: [],
  reach: ["apps"],
};

/** The investigation machine: scanners aimed at the forge's own copies. */
export const SECURITY: Machine = {
  name: "security",
  label: "Security — investigation tools, the forge's own copies only",
  tools: ["gitleaks", "trivy", "osv-scanner", "nuclei", "zap", "testssl.sh", "nmap"],
  reach: ["apps"],
};

export const BUILT_IN: readonly Machine[] = [STANDARD, SECURITY];

export interface MachineConfig {
  /** Built-ins first, then the repository's, a same name replacing. */
  readonly machines: readonly Machine[];
  /** Crew role to machine name; a role not here runs in `standard`. */
  readonly byRole: Readonly<Partial<Record<CrewRole, string>>>;
}

export const NO_CONFIG: MachineConfig = { machines: BUILT_IN, byRole: {} };

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MACHINES_MAX = 16;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const invalid = (message: string) => err(`forge.json: ${message}`);

/** The machines `forge.json` text declares, validated; absent text is none. */
export function parseMachines(
  forgeJson: string | undefined,
): Result<MachineConfig, string> {
  if (forgeJson === undefined) return ok(NO_CONFIG);
  let root: unknown;
  try {
    root = JSON.parse(forgeJson);
  } catch {
    // The manifest parser owns the report of a file that is not JSON.
    return ok(NO_CONFIG);
  }
  if (!isObject(root)) return ok(NO_CONFIG);
  const declared = root["machines"];
  const mapping = root["machineFor"];
  const own: Machine[] = [];
  if (declared !== undefined) {
    if (!isObject(declared))
      return invalid("machines must be an object of named machines");
    const names = Object.keys(declared);
    if (names.length > MACHINES_MAX)
      return invalid(`machines may name at most ${MACHINES_MAX}`);
    for (const name of names) {
      const made = parseMachine(name, declared[name]);
      if (!made.ok) return made;
      own.push(made.value);
    }
  }
  const machines = [
    ...BUILT_IN.filter((b) => !own.some((m) => m.name === b.name)),
    ...own,
  ];
  const byRole: Partial<Record<CrewRole, string>> = {};
  if (mapping !== undefined) {
    if (!isObject(mapping))
      return invalid("machineFor must map a crew role to a machine name");
    for (const [role, name] of Object.entries(mapping)) {
      if (!(CREW_ROLES as readonly string[]).includes(role))
        return invalid(`machineFor "${role}" is not a crew role (${CREW_ROLES.join(", ")})`);
      if (typeof name !== "string" || !machines.some((m) => m.name === name))
        return invalid(
          `machineFor ${role} names a machine that is not declared (${machines.map((m) => m.name).join(", ")})`,
        );
      byRole[role as CrewRole] = name;
    }
  }
  return ok({ machines, byRole });
}

function parseMachine(name: string, value: unknown): Result<Machine, string> {
  if (!NAME_RE.test(name))
    return invalid(`machine name "${name.slice(0, 40)}" must be lowercase letters, digits and dashes`);
  if (!isObject(value)) return invalid(`machines.${name} must be an object`);
  const tools = value["tools"] ?? [];
  if (!Array.isArray(tools)) return invalid(`machines.${name}.tools must be a list`);
  for (const tool of tools)
    if (typeof tool !== "string" || !Object.hasOwn(TOOLS, tool))
      return invalid(`machines.${name}.tools: pick from ${Object.keys(TOOLS).join(", ")}`);
  const reach = value["reach"] ?? ["apps"];
  if (
    !Array.isArray(reach) ||
    reach.some((r) => !(REACHES as readonly unknown[]).includes(r))
  )
    return invalid(`machines.${name}.reach: pick from ${REACHES.join(", ")} (a machine cannot name a host)`);
  const label = value["label"];
  if (label !== undefined && (typeof label !== "string" || label.length > 80))
    return invalid(`machines.${name}.label must be short text`);
  return ok({
    name,
    label: typeof label === "string" && label !== "" ? label : name,
    tools: [...new Set(tools as string[])],
    reach: [...new Set(reach as Reach[])],
  });
}

/** The machine a role runs in: its choice, else the standard one. */
export function machineFor(config: MachineConfig, role: CrewRole | undefined): Machine {
  const name = role === undefined ? undefined : config.byRole[role];
  return config.machines.find((m) => m.name === name) ?? STANDARD;
}

/**
 * The repository's own app URLs a machine lets the sandbox allow: none for
 * a machine without `apps` reach. Never adds a host.
 */
export function reachableApps(machine: Machine, appUrls: readonly string[]): string[] {
  return machine.reach.includes("apps") ? [...appUrls] : [];
}

/** The run's environment for its machine: names only, nothing secret. */
export function machineEnv(machine: Machine): Record<string, string> {
  return {
    FORGE_MACHINE: machine.name,
    FORGE_MACHINE_TOOLS: machine.tools.join(","),
  };
}

/** One line for the brief: where the shell runs and what it was given. */
export function machineNote(machine: Machine): string | undefined {
  if (machine.tools.length === 0) return undefined;
  return (
    `Your shell runs in the \`${machine.name}\` machine. Tools it is meant to carry (use those on PATH; none is installed for you, and each may be aimed only at the forge's own copies): ` +
    machine.tools.map((t) => `${t} (${TOOLS[t]})`).join("; ") +
    "."
  );
}
