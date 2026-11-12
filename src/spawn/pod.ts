/**
 * Pod: renders a child forge's Kubernetes objects as plain data — namespace
 * `forge-child-<name>`, ResourceQuota, PVC, Deployment, Service and
 * default-deny NetworkPolicies in both directions. Nothing here applies
 * anything or reads a cluster; a caller serialises the result (JSON is valid
 * manifest input). Egress allows DNS and TCP 443 to the given IPv4 blocks
 * only; any block that is, or overlaps, a private, loopback, link-local,
 * CGNAT or otherwise non-public range fails the render.
 *
 * Ranges: RFC 1918 (10/8, 172.16/12, 192.168/16), RFC 1122 (0/8, 127/8),
 * RFC 3927 (169.254/16), RFC 6598 (100.64/10), RFC 6890 (192.0.0/24,
 * 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24), RFC 5771 (224/4)
 * and RFC 1112 (240/4).
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface PodLimits {
  readonly cpu: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
}

export const DEFAULT_POD_LIMITS: PodLimits = { cpu: 8, memoryGiB: 16, diskGiB: 50 };
export const MAX_POD_LIMITS: PodLimits = { cpu: 64, memoryGiB: 256, diskGiB: 2048 };

/** Defaults for absent fields; whole numbers from 1 up to the maximum, or one sentence. */
export function parsePodLimits(v: unknown): Result<PodLimits, string> {
  if (v === undefined || v === null) return ok(DEFAULT_POD_LIMITS);
  if (typeof v !== "object" || Array.isArray(v)) return err("limits must be an object");
  const o = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ["cpu", "memoryGiB", "diskGiB"] as const) {
    const x = o[k];
    if (x === undefined) {
      out[k] = DEFAULT_POD_LIMITS[k];
      continue;
    }
    if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > MAX_POD_LIMITS[k]) {
      return err(`${k} must be a whole number from 1 to ${MAX_POD_LIMITS[k]}`);
    }
    out[k] = x;
  }
  return ok(out as unknown as PodLimits);
}

type Cidr = { readonly start: number; readonly end: number };

const DENIED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
  "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
  "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
].map((c) => {
  const b = parseCidr(c);
  if (!b) throw new Error(`bad denied range ${c}`);
  return b;
});

/** IPv4 `a.b.c.d` or `a.b.c.d/n`; a bare address is a /32. Anything else is null. */
function parseCidr(s: string): Cidr | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  let addr = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if ((part.length > 1 && part.startsWith("0")) || Number(part) > 255) return null;
    addr = addr * 256 + Number(part);
  }
  const bits = m[5] === undefined ? 32 : Number(m[5]);
  if (bits > 32) return null;
  const size = 2 ** (32 - bits);
  const start = Math.floor(addr / size) * size;
  if (start !== addr) return null; // host bits set: not a block
  return { start, end: start + size - 1 };
}

/** The canonical blocks, or one sentence naming the first refused address. */
export function parseEgressBlocks(v: unknown): Result<string[], string> {
  if (!Array.isArray(v)) return err("egress must be a list of IPv4 addresses or blocks");
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") return err("egress addresses must be strings");
    const c = parseCidr(raw);
    if (!c) return err(`${JSON.stringify(raw.slice(0, 64))} is not an IPv4 address or block`);
    if (DENIED.some((d) => c.start <= d.end && d.start <= c.end)) {
      return err(`${raw} is, or overlaps, a private or non-public range`);
    }
    out.push(raw.includes("/") ? raw : `${raw}/32`);
  }
  return ok(out);
}

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface PodInput {
  readonly name: string;
  readonly image: string;
  readonly egress: readonly string[];
  readonly limits?: unknown;
}

export interface PodManifests {
  readonly namespace: string;
  readonly objects: readonly Record<string, unknown>[];
}

export function renderPod(input: PodInput): Result<PodManifests, string> {
  if (typeof input.name !== "string" || !NAME.test(input.name)) {
    return err("name must be 1-40 lowercase letters, digits or hyphens, not starting or ending with a hyphen");
  }
  if (typeof input.image !== "string" || !/^[a-z0-9][a-z0-9./_:@-]{0,199}$/.test(input.image)) {
    return err("image must be a plain image reference");
  }
  const limits = parsePodLimits(input.limits);
  if (!limits.ok) return limits;
  const blocks = parseEgressBlocks(input.egress);
  if (!blocks.ok) return blocks;

  const ns = `forge-child-${input.name}`;
  const labels = { "app.kubernetes.io/name": "forge-child", "forge/child": input.name };
  const { cpu, memoryGiB, diskGiB } = limits.value;
  const meta = (name: string) => ({ name, namespace: ns, labels });

  const objects: Record<string, unknown>[] = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: ns, labels } },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta("child"),
      spec: {
        hard: {
          "limits.cpu": String(cpu),
          "limits.memory": `${memoryGiB}Gi`,
          "requests.storage": `${diskGiB}Gi`,
          pods: "2",
          services: "2",
          persistentvolumeclaims: "1",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: meta("data"),
      spec: { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: `${diskGiB}Gi` } } },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta("child"),
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001 },
            containers: [
              {
                name: "forge",
                image: input.image,
                env: [{ name: "FORGE_APP_DATA", value: "/data" }],
                ports: [{ containerPort: 3000 }],
                resources: { limits: { cpu: String(cpu), memory: `${memoryGiB}Gi` } },
                securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
                volumeMounts: [{ name: "data", mountPath: "/data" }, { name: "tmp", mountPath: "/tmp" }],
              },
            ],
            volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data" } }, { name: "tmp", emptyDir: { sizeLimit: "1Gi" } }],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta("child"),
      spec: { selector: labels, ports: [{ port: 80, targetPort: 3000 }] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("default-deny"),
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta("allow-egress"),
      spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
            ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }],
          },
          ...(blocks.value.length
            ? [{ to: blocks.value.map((cidr) => ({ ipBlock: { cidr } })), ports: [{ protocol: "TCP", port: 443 }] }]
            : []),
        ],
      },
    },
  ];
  return ok({ namespace: ns, objects });
}
