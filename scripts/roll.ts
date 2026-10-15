/**
 * Whether a surge pod can schedule, and the headroom it lacks (#1588, part
 * of #873).
 *
 * The chart rolls with `maxSurge: 1, maxUnavailable: 0`: the new forge pod
 * comes up beside the old one and the old one drains only once the new one
 * is ready. Local-path storage binds the volume to one node, so the new pod
 * must fit on *that* node, beside the old one. When it does not, the roll
 * cannot be zero-downtime.
 *
 * Plain data in, plain data out. `scripts/roll-preflight.ts` reads what
 * `kubectl` printed and prints what this answers; nothing here talks to a
 * cluster.
 *
 * The rule, in the scheduler's own terms (NodeResourcesFit):
 *
 *   free      = node.status.allocatable − Σ requests of the pods on the node
 *   need.cpu  = the forge pod's cpu request
 *   need.mem  = max(the forge pod's memory request, its steady memory)
 *   fits      ⇔ free.cpu ≥ need.cpu  ∧  free.mem ≥ need.mem
 *   short by  = max(0, need − free), per resource
 *
 * Steady memory is in `need` because the request is a floor, not what the
 * pod holds: a pod requesting 2 Gi that steadies at 3.6 Gi schedules on
 * 2 Gi free, and then both pods together hold more than the node has.
 */

/**
 * Whole millicores and whole bytes, as the scheduler counts them (a
 * quantity is rounded up to its unit, `Quantity.MilliValue`), so `4100m −
 * 3100m` is exactly `1000m` and never a hair under it.
 */
export interface Resources {
  readonly milliCpu: number;
  readonly memory: number;
}

const SCALE: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  "": 1,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const QUANTITY =
  /^([0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:([eE][+-]?[0-9]{1,2})|(Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|M|G|T|P|E))?$/;

/**
 * A Kubernetes resource quantity (`resource.Quantity`): `8130464Ki`, `2Gi`,
 * `500m`, `1.5`, `12e6`. Answers the plain number (bytes, or cores), or
 * null for anything that is not one — never a guess.
 */
export function parseQuantity(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = QUANTITY.exec(text.trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (m[2]) return base * 10 ** Number(m[2].slice(1));
  const scale = SCALE[m[3] ?? ""];
  return scale === undefined ? null : base * scale;
}

const ZERO: Resources = { milliCpu: 0, memory: 0 };

function add(a: Resources, b: Resources): Resources {
  return { milliCpu: a.milliCpu + b.milliCpu, memory: a.memory + b.memory };
}

function max(a: Resources, b: Resources): Resources {
  return {
    milliCpu: Math.max(a.milliCpu, b.milliCpu),
    memory: Math.max(a.memory, b.memory),
  };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `{cpu, memory}` from a requests/allocatable map; absent reads as zero. */
function resources(map: unknown, where: string): Resources {
  const m = obj(map);
  const read = (key: "cpu" | "memory"): number => {
    if (m[key] === undefined) return 0;
    const n = parseQuantity(m[key]);
    if (n === null)
      throw new Error(
        `${where}: ${key} ${JSON.stringify(m[key]).slice(0, 40)} is not a quantity`,
      );
    return n;
  };
  // Round up to the unit, as the scheduler does; the epsilon keeps 0.1 × 1000
  // from becoming 101.
  return {
    milliCpu: Math.ceil(read("cpu") * 1000 - 1e-6),
    memory: Math.ceil(read("memory") - 1e-6),
  };
}

/**
 * What the scheduler reserves for a pod (Kubernetes ≥ 1.29, "Resource
 * sharing within containers"): the containers and sidecars (init
 * containers with `restartPolicy: Always`) summed; each plain init
 * container, with the sidecars started before it, taken as a floor; plus
 * the runtime class's overhead.
 */
export function podRequest(pod: unknown): Resources {
  const spec = obj(obj(pod)["spec"]);
  const name = String(obj(obj(pod)["metadata"])["name"] ?? "?");
  const req = (c: unknown) =>
    resources(obj(obj(c)["resources"])["requests"], `pod ${name}`);
  let sidecars = ZERO;
  let initFloor = ZERO;
  for (const c of list(spec["initContainers"])) {
    if (obj(c)["restartPolicy"] === "Always") sidecars = add(sidecars, req(c));
    else initFloor = max(initFloor, add(req(c), sidecars));
  }
  let sum = sidecars;
  for (const c of list(spec["containers"])) sum = add(sum, req(c));
  return add(max(sum, initFloor), resources(spec["overhead"], `pod ${name}`));
}

/** A pod the scheduler still counts against its node. */
function holdsNode(pod: unknown, node: string): boolean {
  const phase = obj(obj(pod)["status"])["phase"];
  return (
    obj(obj(pod)["spec"])["nodeName"] === node &&
    phase !== "Succeeded" &&
    phase !== "Failed"
  );
}

export interface SurgeInput {
  /** `kubectl get node <node> -o json`. */
  readonly node: unknown;
  /** `kubectl get pods -A -o json` (pods on other nodes are ignored). */
  readonly pods: unknown;
  /** The running forge pod, `namespace/name`. */
  readonly forgePod: string;
  /** Its steady memory in bytes (`kubectl top pod`, over a quiet minute). */
  readonly steadyMemory: number;
}

export interface Surge {
  readonly node: string;
  readonly allocatable: Resources;
  readonly requested: Resources;
  readonly podsOnNode: number;
  readonly free: Resources;
  readonly forgeRequest: Resources;
  readonly steadyMemory: number;
  readonly need: Resources;
  /** Would the scheduler place the surge pod at all (requests only)? */
  readonly schedulable: boolean;
  /** Would it place it *and* would both pods' steady memory fit? */
  readonly fits: boolean;
  /** What more must be free on this node for the roll to be zero-downtime. */
  readonly shortfall: Resources;
}

const POD =
  /^([a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)\/([a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?)$/;

/** Answer. Throws on input that is not what `kubectl` prints. */
export function surge(input: SurgeInput): Surge {
  const pod = POD.exec(input.forgePod.trim());
  if (!pod)
    throw new Error(
      `forge pod ${JSON.stringify(input.forgePod).slice(0, 80)} is not namespace/name`,
    );
  const [ns, podName] = [pod[1], pod[2]];
  if (!Number.isFinite(input.steadyMemory) || input.steadyMemory <= 0)
    throw new Error("steady memory must be a positive quantity");
  const steadyMemory = Math.ceil(input.steadyMemory);

  const nodeName = obj(obj(input.node)["metadata"])["name"];
  if (typeof nodeName !== "string" || nodeName === "")
    throw new Error("node: no metadata.name — is it `kubectl get node -o json`?");
  const allocatable = resources(
    obj(obj(input.node)["status"])["allocatable"],
    `node ${nodeName}`,
  );
  if (allocatable.memory <= 0 || allocatable.milliCpu <= 0)
    throw new Error(`node ${nodeName}: no status.allocatable cpu and memory`);

  const items = list(obj(input.pods)["items"]);
  const forge = items.find((p) => {
    const m = obj(obj(p)["metadata"]);
    return m["namespace"] === ns && m["name"] === podName;
  });
  if (!forge) throw new Error(`pods: no ${ns}/${podName} in the list`);
  if (obj(obj(forge)["spec"])["nodeName"] !== nodeName)
    throw new Error(
      `${ns}/${podName} is not on node ${nodeName}: the volume's node is the one to judge`,
    );

  const onNode = items.filter((p) => holdsNode(p, nodeName));
  const requested = onNode.reduce<Resources>((s, p) => add(s, podRequest(p)), ZERO);
  const free = {
    milliCpu: allocatable.milliCpu - requested.milliCpu,
    memory: allocatable.memory - requested.memory,
  };
  const forgeRequest = podRequest(forge);
  const need = {
    milliCpu: forgeRequest.milliCpu,
    memory: Math.max(forgeRequest.memory, steadyMemory),
  };
  return {
    node: nodeName,
    allocatable,
    requested,
    podsOnNode: onNode.length,
    free,
    forgeRequest,
    steadyMemory,
    need,
    schedulable:
      free.milliCpu >= forgeRequest.milliCpu && free.memory >= forgeRequest.memory,
    fits: free.milliCpu >= need.milliCpu && free.memory >= need.memory,
    shortfall: {
      milliCpu: Math.max(0, need.milliCpu - free.milliCpu),
      memory: Math.max(0, need.memory - free.memory),
    },
  };
}

const MiB = 2 ** 20;
/** Whole MiB, rounded up: a shortfall printed is never less than the real one. */
const mib = (bytes: number) =>
  `${bytes < 0 ? "-" : ""}${Math.ceil(Math.abs(bytes) / MiB)} MiB`;
const cpu = (milli: number) => `${milli}m cpu`;

/** The answer as plain lines, for the roll recipe to print. */
export function report(s: Surge): string {
  const row = (label: string, r: Resources, extra = "") =>
    `  ${label.padEnd(18)}${mib(r.memory).padStart(10)}  ${cpu(r.milliCpu).padStart(11)}${extra}`;
  const head = s.fits
    ? `surge on ${s.node}: fits — the roll is zero-downtime`
    : s.schedulable
      ? `surge on ${s.node}: does NOT fit — the pod would schedule, but both pods' steady memory would not`
      : `surge on ${s.node}: does NOT fit — the surge pod cannot schedule`;
  const lines = [
    head,
    row("node allocatable", s.allocatable),
    row("requested now", s.requested, `  (${s.podsOnNode} pods)`),
    row("free", s.free),
    row(
      "surge pod needs",
      s.need,
      `  (request ${mib(s.forgeRequest.memory)}, steady ${mib(s.steadyMemory)})`,
    ),
  ];
  if (!s.fits)
    lines.push(
      row("short by", s.shortfall),
      `zero-downtime needs ${mib(s.shortfall.memory)} and ${cpu(s.shortfall.milliCpu)} more free on ${s.node}` +
        " (a larger node, or fewer requests on this one)",
    );
  return lines.join("\n");
}
