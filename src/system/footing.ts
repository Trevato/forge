/**
 * What the forge stands on (#11685): every piece the forge needs to answer a
 * request, sign a person in, build, release and back up, where each was
 * found running, and what happens to the forge if that machine dies.
 *
 * `FOOTING` is the declared list, from the steward's read-only inventory of
 * both machines on 2026-11-12, the day a full disk on pg-grand (DigitalOcean)
 * took the forge off the internet for 24 minutes while the forge itself ran on
 * the vxrail, and the owner decided to drop pg-grand. `docs/OPERATING.md` carries the same list as
 * a table (`footingTable` writes it; `test/footing.test.ts` holds the doc to
 * it), so the two cannot drift.
 *
 * `probeFooting` reads the live cluster over the kube API with the forge's
 * own service account: the forge's node (its own pod's `spec.nodeName`), the
 * control-plane nodes, and the node of each piece's pods. A piece the cluster
 * cannot show (a systemd unit on a host, a CronJob with no pod now, a
 * namespace the service account may not list) keeps its declared machine and
 * says so. Any required piece not on the forge's own machine is a risk line.
 * Only namespaced pod lists are asked for, never the whole cluster's.
 *
 * `footing` holds the last reading for 60 s in process memory (named in
 * AGENTS.md), so /system, its terminal screen (`src/tui/screens/footing.ts`)
 * and the MCP answer share one read and a page never waits on the cluster for
 * more than `WAIT_MS`; a probe that throws is not retried for 60 s.
 *
 * The descriptions carry no figure that goes stale (disk fill, sizes, counts):
 * those were true on one day and are not re-read here.
 */
import { serviceAccount, type Credentials } from "../cluster/jobs.ts";

export type Need = "answer" | "sign-in" | "build" | "release" | "backup";

/** The machines in the forge's path, by the name the steward's inventory gives them. */
export type Machine = "pg-grand" | "vxrail";

/** The machine the forge itself runs on, as declared. */
export const FORGE_MACHINE: Machine = "vxrail";

/** What each machine is, from the steward's read-only inventory of 2026-11-12. */
export const MACHINES: Record<Machine, string> = {
  "pg-grand": "DigitalOcean. The k3s server, a single control plane with no HA. The owner decided on 2026-11-12 to drop it.",
  vxrail: "A k3s agent joined to pg-grand. The forge runs here.",
};

export type Find =
  /** Pods of one workload (Deployment, StatefulSet, DaemonSet) in a namespace, or every pod (`*`); namespace `""` is the forge's own. */
  | { readonly kind: "pods"; readonly namespace: string; readonly workload: string }
  /** The forge's own pod. */
  | { readonly kind: "self" }
  /** The Kubernetes API server: the nodes labelled control-plane. */
  | { readonly kind: "control-plane" }
  /** Not in the cluster: a systemd unit on a host; the cluster cannot show it, so the declared machine stands. */
  | { readonly kind: "host"; readonly unit: string }
  /** A pod whose namespace is not recorded: not looked for, since that would list every pod in the cluster. */
  | { readonly kind: "unlocated" };

export interface Piece {
  readonly id: string;
  readonly need: Need;
  readonly what: string;
  readonly find: Find;
  /** Where it ran when the list was written. */
  readonly machine: Machine;
  /** What happens to the forge if that machine dies. */
  readonly ifDies: string;
  /** The issues that remove the dependency; none for a piece on the forge's own machine. */
  readonly issues: readonly number[];
  /** With pg-grand switched off, the step at which this piece fails the forge (1 first). */
  readonly breaks?: number;
}

export const NEEDS: readonly Need[] = ["answer", "sign-in", "build", "release", "backup"];

/** The steps in which the forge breaks if pg-grand is switched off now, in order. */
export const BREAK_STEPS: readonly string[] = [
  "Traefik: nothing public reaches the forge",
  "plat-auth: no one signs in",
  "the signup gate: no one signs up",
  "image pulls and releases",
  "the control plane: nothing reschedules, Services stop updating",
  "local backups",
  "the host timers",
];

const SAME_DEATH = "It goes with the forge, which runs beside it.";

export const FOOTING: readonly Piece[] = [
  {
    id: "forge",
    need: "answer",
    what: "The forge's pod (git.open-platform.sh/trevato-apps/forge:<version>) and its data, PVC forge-data-vxrail (60 Gi)",
    find: { kind: "self" },
    machine: "vxrail",
    ifDies: "The forge is down, and its data is on that disk.",
    issues: [],
  },
  {
    id: "tunnel",
    need: "answer",
    what: "Cloudflare tunnel carrying forge.open-platform.sh (standby/cloudflared), moved to the vxrail by hand on 2026-11-12; its last-applied manifest still says 0 replicas, so a re-render moves it back",
    find: { kind: "pods", namespace: "standby", workload: "cloudflared" },
    machine: "vxrail",
    ifDies: SAME_DEATH,
    issues: [8948, 11686],
  },
  {
    id: "tunnel-home",
    need: "answer",
    what: "The vxrail's own tunnel (standby/cloudflared-forge-home, 2 replicas): it too sends *.open-platform.sh to Traefik; only forge-home-test.open-platform.sh and arm--forge-trevato-apps.open-platform.sh go straight to the forge",
    find: { kind: "pods", namespace: "standby", workload: "cloudflared-forge-home" },
    machine: "vxrail",
    ifDies: SAME_DEATH,
    issues: [],
  },
  {
    id: "traefik",
    need: "answer",
    what: "Traefik (kube-system/traefik): every public request goes tunnel → Traefik → the forge's Service",
    find: { kind: "pods", namespace: "kube-system", workload: "traefik" },
    machine: "pg-grand",
    ifDies: "The forge is off the internet; it keeps running inside.",
    issues: [11686, 8946],
    breaks: 1,
  },
  {
    id: "hosts",
    need: "answer",
    what: "Child and app hosts, Traefik IngressRoutes forge-children (<name>--forge.open-platform.sh), forge-apps (*--forge-trevato-apps.open-platform.sh) and forge-old-host, and game.cheffryjames.com and www.cheffryjames.com in the forge's namespace",
    find: { kind: "pods", namespace: "kube-system", workload: "traefik" },
    machine: "pg-grand",
    ifDies: "No child forge, app or custom domain answers.",
    issues: [11686, 8946],
    breaks: 1,
  },
  {
    id: "forge-ssh",
    need: "answer",
    what: "forge-ssh, a host socket proxy (:2222 → the forge's ssh service)",
    find: { kind: "host", unit: "forge-ssh" },
    machine: "pg-grand",
    ifDies: "git over ssh and the terminal stop answering.",
    issues: [11686],
    breaks: 7,
  },
  {
    id: "control-plane",
    need: "answer",
    what: "The k3s API server (the vxrail is an agent joined to it)",
    find: { kind: "control-plane" },
    machine: "pg-grand",
    ifDies: "Running pods keep running, but nothing reschedules, Services stop updating, and no release rolls or Job runs.",
    issues: [11686],
    breaks: 5,
  },
  {
    id: "plat-auth",
    need: "sign-in",
    what: "Sign-in edge: a forwardAuth middleware on the forge's Ingress, answered by mcp/plat-auth",
    find: { kind: "pods", namespace: "mcp", workload: "plat-auth" },
    machine: "pg-grand",
    ifDies: "Every request through the edge answers 500, /healthz too.",
    issues: [11686],
    breaks: 2,
  },
  {
    id: "signup-gate",
    need: "sign-in",
    what: "forge-signup-gate, the pod /signup is routed to",
    // An Ingress routes only to a Service in its own namespace: the forge's.
    find: { kind: "pods", namespace: "", workload: "forge-signup-gate" },
    machine: "pg-grand",
    ifDies: "No one can sign up.",
    issues: [11686],
    breaks: 3,
  },
  {
    id: "forgejo",
    need: "build",
    what: "Forgejo (git.open-platform.sh) and its Actions, which build the release image",
    find: { kind: "pods", namespace: "forgejo", workload: "*" },
    machine: "pg-grand",
    ifDies: "No release image is built.",
    issues: [11686, 8941],
    breaks: 4,
  },
  {
    id: "cnpg",
    need: "build",
    what: "Forgejo's database, a single instance under CloudNativePG (cnpg-system)",
    find: { kind: "pods", namespace: "cnpg-system", workload: "*" },
    machine: "pg-grand",
    ifDies: "Forgejo stops, and with it builds.",
    issues: [11686, 8941],
    breaks: 4,
  },
  {
    id: "runner",
    need: "build",
    what: "forgejo-runner-vxrail, a Forgejo Actions runner",
    find: { kind: "unlocated" },
    machine: "vxrail",
    ifDies: SAME_DEATH,
    issues: [],
  },
  {
    id: "registry",
    need: "release",
    what: "Forgejo's registry (git.open-platform.sh), which the forge's image is pulled from",
    find: { kind: "pods", namespace: "forgejo", workload: "*" },
    machine: "pg-grand",
    ifDies: "A pod that restarts on a node without the image cached cannot start; nothing new is released.",
    issues: [11686, 8941, 8942],
    breaks: 4,
  },
  {
    id: "registry-node",
    need: "release",
    what: "registry-node, a registry on the vxrail",
    find: { kind: "unlocated" },
    machine: "vxrail",
    ifDies: SAME_DEATH,
    issues: [],
  },
  {
    id: "release-tick",
    need: "release",
    what: "forge-release-tick, a host timer every 5 min",
    find: { kind: "host", unit: "forge-release-tick" },
    machine: "pg-grand",
    ifDies: "Nothing is released; production keeps the release it has.",
    issues: [11686, 8942],
    breaks: 7,
  },
  {
    id: "standby-reconcile",
    need: "release",
    what: "standby-reconcile, a host timer every 2 min that applies the forge's manifests from Forgejo; Flux's Kustomization for the forge is suspended",
    find: { kind: "host", unit: "standby-reconcile" },
    machine: "pg-grand",
    ifDies: "A changed manifest is not applied; the running pod is untouched.",
    issues: [8948, 11686],
    breaks: 7,
  },
  {
    id: "host-timers",
    need: "release",
    what: "Host timers forge-watchdog, forge-github-mirror and forge-prune-images",
    find: { kind: "host", unit: "forge-watchdog" },
    machine: "pg-grand",
    ifDies: "The watchdog, the GitHub mirror and image pruning under the Deployment-patch deployer stop.",
    issues: [11686, 11914],
    breaks: 7,
  },
  {
    id: "release-prune",
    need: "release",
    what: "The self-swap keeper's own pruning of release trees",
    find: { kind: "self" },
    machine: "vxrail",
    ifDies: SAME_DEATH,
    issues: [11801, 11914],
  },
  {
    id: "backup-lanes",
    need: "backup",
    what: "The backup namespace's CronJobs (FORGE_BACKUP_LANES)",
    find: { kind: "pods", namespace: "backup", workload: "*" },
    machine: "pg-grand",
    ifDies: "No new backup is taken.",
    issues: [11686],
    breaks: 6,
  },
  {
    id: "minio",
    need: "backup",
    what: "MinIO, where the backup lanes store the forge's backups",
    find: { kind: "pods", namespace: "minio", workload: "*" },
    machine: "pg-grand",
    ifDies: "No new backup is stored, and those it holds go with the machine.",
    issues: [11686],
    breaks: 6,
  },
];

/** On pg-grand, not in the forge's path: what dropping the machine takes besides. */
export const ALSO_ON_PG_GRAND =
  "Forgejo and its database, the platform's mcp/plat-auth and www, the CloudNativePG operator with the tenant apps' databases, their local-path volumes pinned to that node, and MinIO.";

/** How each piece was placed: seen on nodes, or the declared machine kept and why. */
export type Seen =
  | { readonly by: "cluster"; readonly nodes: readonly string[] }
  | { readonly by: "declared"; readonly why: string };

export interface FootingRow extends Piece {
  readonly seen: Seen;
  /** True when the piece is not on the forge's own machine (or cannot be shown to be). */
  readonly risk: boolean;
}

export interface Footing {
  /** The forge's own node; null outside a cluster or when its pod cannot be read. */
  readonly forgeNode: string | null;
  /** Why the cluster was not read, when it was not. */
  readonly unread: string | null;
  readonly rows: readonly FootingRow[];
  readonly at: string;
}

/** A pod belongs to a workload: `<w>-<rs>-<id>` (Deployment), `<w>-<n>` (StatefulSet), `<w>-<id>` (DaemonSet). */
export function ownedBy(pod: string, workload: string): boolean {
  if (workload === "*") return true;
  if (!pod.startsWith(`${workload}-`)) return false;
  const rest = pod.slice(workload.length + 1);
  return /^[a-z0-9]{5,10}-[a-z0-9]{5}$/.test(rest) || /^\d+$/.test(rest) || /^[a-z0-9]{5}$/.test(rest);
}

/** Rows for the declared list alone: every piece placed on its declared machine. */
export function declaredFooting(why: string, at = new Date()): Footing {
  return {
    forgeNode: null,
    unread: why,
    at: at.toISOString(),
    rows: FOOTING.map((p) => ({ ...p, seen: { by: "declared", why }, risk: p.machine !== FORGE_MACHINE })),
  };
}

type KubeFetch = (url: string, init: RequestInit & { tls?: { ca: string } }) => Promise<Response>;

export interface ProbeOptions {
  fetch?: KubeFetch;
  /** The forge's service account, or how to read it (it throws outside a cluster). */
  credentials?: Credentials | (() => Credentials);
  /** The forge's own pod name; the kubelet sets HOSTNAME to it. */
  podName?: string;
  now?: () => Date;
}

type PodList = { items?: { metadata?: { name?: string }; spec?: { nodeName?: string }; status?: { phase?: string } }[] };
type NodeList = { items?: { metadata?: { name?: string; labels?: Record<string, string> } }[] };

const CONTROL_LABELS = ["node-role.kubernetes.io/control-plane", "node-role.kubernetes.io/master"];

/** Read the live cluster; never throws. Outside a cluster, the declared list with why. */
export async function probeFooting(opts: ProbeOptions = {}): Promise<Footing> {
  const now = opts.now ?? (() => new Date());
  let cred: Credentials;
  try {
    const c = opts.credentials ?? serviceAccount;
    cred = typeof c === "function" ? c() : c;
  } catch (e) {
    return declaredFooting(`not read: ${e instanceof Error ? e.message : String(e)}`, now());
  }
  const doFetch: KubeFetch = opts.fetch ?? ((u, i) => fetch(u, i as RequestInit));
  const get = async <T>(path: string): Promise<{ ok: true; value: T } | { ok: false; status: number | string }> => {
    try {
      const res = await doFetch(`${cred.server}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${cred.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(3000),
        ...(cred.ca ? { tls: { ca: cred.ca } } : {}),
      });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, value: (await res.json()) as T };
    } catch (e) {
      return { ok: false, status: e instanceof Error ? e.message : "unreachable" };
    }
  };
  const refused = (s: number | string, what: string): string =>
    s === 403 ? `the forge's service account may not read ${what}` : `${what} not read (${s})`;

  const podName = opts.podName ?? process.env["HOSTNAME"] ?? "";
  const self = podName
    ? await get<{ spec?: { nodeName?: string } }>(`/api/v1/namespaces/${encodeURIComponent(cred.namespace)}/pods/${encodeURIComponent(podName)}`)
    : null;
  const forgeNode = self?.ok ? (self.value.spec?.nodeName ?? null) : null;

  const nodes = await get<NodeList>("/api/v1/nodes");
  const nsOf = (ns: string): string => ns || cred.namespace;
  const namespaces = [...new Set(FOOTING.flatMap((p) => (p.find.kind === "pods" ? [nsOf(p.find.namespace)] : [])))];
  const pods = new Map(
    await Promise.all(namespaces.map(async (ns) => [ns, await get<PodList>(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods`)] as const)),
  );
  const controlNodes = nodes.ok
    ? (nodes.value.items ?? []).filter((n) => CONTROL_LABELS.some((l) => n.metadata?.labels?.[l] !== undefined)).map((n) => n.metadata?.name ?? "").filter(Boolean)
    : null;

  const place = (p: Piece): Seen => {
    const f = p.find;
    if (f.kind === "self") {
      if (forgeNode !== null) return { by: "cluster", nodes: [forgeNode] };
      return { by: "declared", why: self === null ? "the forge's pod name is unknown" : self.ok ? "its pod has no node yet" : refused(self.status, "its own pod") };
    }
    if (f.kind === "control-plane") {
      if (!nodes.ok) return { by: "declared", why: refused(nodes.status, "nodes") };
      return controlNodes!.length ? { by: "cluster", nodes: controlNodes! } : { by: "declared", why: "no node is labelled control-plane" };
    }
    // Nothing in the cluster sees a systemd unit: the declared machine stands, said as such.
    if (f.kind === "host") return { by: "declared", why: `${f.unit} is a systemd unit on a host; the cluster cannot show it` };
    if (f.kind === "unlocated") return { by: "declared", why: "its namespace is not recorded, and the forge does not list every pod in the cluster" };
    const where = nsOf(f.namespace);
    const list = pods.get(where)!;
    if (!list.ok) return { by: "declared", why: refused(list.status, `pods in ${where}`) };
    const on = (list.value.items ?? [])
      .filter((i) => ownedBy(i.metadata?.name ?? "", f.workload) && i.status?.phase !== "Succeeded" && i.status?.phase !== "Failed")
      .map((i) => i.spec?.nodeName ?? "")
      .filter(Boolean);
    return on.length ? { by: "cluster", nodes: [...new Set(on)].sort() } : { by: "declared", why: `no pod running in ${where} now` };
  };

  const rows = FOOTING.map((p): FootingRow => {
    const seen = place(p);
    const risk =
      seen.by === "cluster" && forgeNode !== null
        ? seen.nodes.some((n) => n !== forgeNode)
        : p.machine !== FORGE_MACHINE;
    return { ...p, seen, risk };
  });
  const unread =
    forgeNode !== null ? null
    : self === null ? "the forge's pod name is unknown (HOSTNAME unset)"
    : self.ok ? "the forge's own pod has no node yet"
    : refused(self.status, "its own pod");
  return { forgeNode, unread, rows, at: now().toISOString() };
}

/** Where a row was placed, in words. */
export function whereWords(r: FootingRow): string {
  return r.seen.by === "cluster" ? r.seen.nodes.join(", ") : `${r.machine} (declared: ${r.seen.why})`;
}

/** The rows off the forge's machine, in the order pg-grand switched off would break the forge; ties keep the list's order. */
export function offMachine(f: Footing): FootingRow[] {
  return f.rows
    .filter((r) => r.risk)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.breaks ?? 99) - (b.r.breaks ?? 99) || a.i - b.i)
    .map(({ r }) => r);
}

/** The risk lines: one per required piece off the forge's machine, in the order they would break it. */
export function riskLines(f: Footing): string[] {
  return offMachine(f).map((r) => `${r.need}: ${r.what} on ${whereWords(r)}. ${r.ifDies}`);
}

const FRESH_MS = 60_000;
/** After a probe that throws, the next is not started for this long, so a broken cluster costs one try a minute. */
const BACKOFF_MS = 60_000;
const WAIT_MS = 800;

/** The last reading shared by /system, its terminal screen and the MCP answer. */
export function footingCache(probe: () => Promise<Footing> = () => probeFooting(), clock: () => number = Date.now) {
  let last: { at: number; value: Footing } | null = null;
  let pending: Promise<Footing> | null = null;
  let failedAt: number | null = null;
  const stale = (): boolean => !last || clock() - last.at > FRESH_MS;
  const backingOff = (): boolean => failedAt !== null && clock() - failedAt < BACKOFF_MS;
  const refresh = (): Promise<Footing> => {
    pending ??= probe()
      .then((value) => {
        last = { at: clock(), value };
        failedAt = null;
        return value;
      })
      .catch((e: unknown) => {
        failedAt = clock();
        throw e;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    /** The last reading, refreshed in the background when older than 60 s; null before the first. */
    peek(): Footing | null {
      if (stale() && !backingOff()) void refresh().catch(() => {});
      return last?.value ?? null;
    },
    /** A fresh-enough reading, waiting at most `waitMs` for the cluster; the declared list when it is slower. */
    async read(waitMs = WAIT_MS): Promise<Footing> {
      if (!stale()) return last!.value;
      if (backingOff()) return last?.value ?? declaredFooting("the cluster did not answer; it is asked again within a minute");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<null>((r) => {
        deadline = setTimeout(() => r(null), waitMs);
      });
      try {
        const got = await Promise.race([refresh().catch(() => null), timer]);
        return got ?? last?.value ?? declaredFooting("the cluster did not answer in time; reload in a moment");
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}

export const footing = footingCache();

const NEED_WORDS: Record<Need, string> = {
  answer: "(a) answer a request",
  "sign-in": "(b) sign a person in",
  build: "(c) build",
  release: "(d) release",
  backup: "(e) back up",
};

/** Markdown text: a pipe would end a cell, and `<name>` would read as a tag. */
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** What `docs/OPERATING.md` carries between its markers, written from `MACHINES`, `FOOTING` and `BREAK_STEPS`. */
export function footingTable(): string {
  const machines = (Object.keys(MACHINES) as Machine[]).map((m) => `- **${m}**: ${cell(MACHINES[m])}`);
  const head = "| Needed to | Piece | Runs on | If that machine dies | Breaks | Removed by |\n|---|---|---|---|---|---|";
  const lines = NEEDS.flatMap((need) =>
    FOOTING.filter((p) => p.need === need).map(
      (p) =>
        `| ${NEED_WORDS[need]} | ${cell(p.what)} | ${p.machine} | ${cell(p.ifDies)} | ${p.breaks ?? "—"} | ${p.issues.map((n) => `#${n}`).join(", ") || "—"} |`,
    ),
  );
  const steps = BREAK_STEPS.map((s, i) => `${i + 1}. ${cell(s)}`);
  return [
    ...machines,
    "",
    head,
    ...lines,
    "",
    "If pg-grand were switched off now, the forge breaks in this order (the Breaks column):",
    "",
    ...steps,
    "",
    `Also on pg-grand, not in the forge's path: ${cell(ALSO_ON_PG_GRAND)}`,
  ].join("\n");
}
