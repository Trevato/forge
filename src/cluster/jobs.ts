/**
 * Run one Kubernetes Job to the end: create it, poll until it succeeds,
 * fails or the deadline passes, read its log, and delete it in every case.
 * The kube API is spoken over `fetch` with the service account's token and
 * CA from the standard paths; the client, the credentials and the clock are
 * injectable. Plain data in (a `JobSpec`), plain data out (a `JobResult`).
 */
import { readFileSync } from "node:fs";

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const NAME = /^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$/;
const MAX_LOG_BYTES = 1_000_000;

export type Toleration = {
  key?: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

export type JobSpec = {
  /** A DNS label, at most 53 characters. */
  name: string;
  image: string;
  command: string[];
  env?: Record<string, string>;
  nodeSelector?: Record<string, string>;
  tolerations?: Toleration[];
};

export type JobResult = {
  /** The container's exit code; null when it never ran to the end. */
  exitCode: number | null;
  lines: string[];
  timedOut: boolean;
};

export type Credentials = { server: string; token: string; ca?: string; namespace: string };

export type JobOptions = {
  /** Stand-in for fetch; real calls pass the CA through `tls`. */
  fetch?: (url: string, init: RequestInit & { tls?: { ca: string } }) => Promise<Response>;
  credentials?: Credentials;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** The most log bytes read; the rest of the log is left unread. */
  maxLogBytes?: number;
};

/** The service account the pod runs as; throws when there is none. */
export function serviceAccount(dir = SA_DIR, env: Record<string, string | undefined> = process.env): Credentials {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error("not running in a cluster");
  const port = env.KUBERNETES_SERVICE_PORT || "443";
  const read = (f: string) => readFileSync(`${dir}/${f}`, "utf8").trim();
  return {
    server: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
    token: read("token"),
    ca: read("ca.crt"),
    namespace: read("namespace"),
  };
}

/** The Job manifest for a spec, or the reason it is refused. */
export function manifest(spec: JobSpec): object {
  if (!NAME.test(spec.name ?? "")) throw new Error("job name must be a DNS label of at most 53 characters");
  if (typeof spec.image !== "string" || !spec.image || /\s/.test(spec.image)) throw new Error("image is required");
  if (!Array.isArray(spec.command) || !spec.command.length || spec.command.some((c) => typeof c !== "string"))
    throw new Error("command must be a non-empty list of strings");
  const env = Object.entries(spec.env ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") throw new Error(`bad env ${name}`);
    return { name, value };
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: spec.name },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { "job-name": spec.name } },
        spec: {
          restartPolicy: "Never",
          nodeSelector: spec.nodeSelector ?? {},
          tolerations: spec.tolerations ?? [],
          containers: [{ name: "job", image: spec.image, command: spec.command, env }],
        },
      },
    },
  };
}

/** The few fields of the kube API's answers this module reads. */
type Job = { status?: { succeeded?: number; failed?: number } };
type Pod = {
  metadata?: { name?: string };
  status?: { containerStatuses?: { state?: { terminated?: { exitCode?: number } } }[] };
};
type PodList = { items?: Pod[] };

export async function runJob(spec: JobSpec, opts: JobOptions = {}): Promise<JobResult> {
  const body = JSON.stringify(manifest(spec));
  const cred = opts.credentials ?? serviceAccount();
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i as RequestInit));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1000;
  const max = opts.maxLogBytes ?? MAX_LOG_BYTES;
  const ns = encodeURIComponent(cred.namespace);
  const name = encodeURIComponent(spec.name);

  const call = (method: string, path: string, payload?: string) =>
    doFetch(`${cred.server}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cred.token}`,
        accept: "application/json",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload,
      ...(cred.ca ? { tls: { ca: cred.ca } } : {}),
    });
  const json = async <T>(method: string, path: string, payload?: string): Promise<T> => {
    const res = await call(method, path, payload);
    if (!res.ok) throw new Error(`kube ${method} ${res.status}`);
    return (await res.json()) as T;
  };

  const jobPath = `/apis/batch/v1/namespaces/${ns}/jobs/${name}`;
  let created = false;
  try {
    // Only a Job this call made is this call's to delete: a 4xx (409
    // AlreadyExists above all) means the API made nothing; anything else
    // (a 5xx, a dropped connection) may have, so it is deleted.
    let made: Response;
    try {
      made = await call("POST", `/apis/batch/v1/namespaces/${ns}/jobs`, body);
    } catch (e) {
      created = true;
      throw e;
    }
    if (!made.ok) {
      created = made.status >= 500;
      throw new Error(`kube POST ${made.status}`);
    }
    created = true;

    const deadline = now() + timeoutMs;
    let done: "succeeded" | "failed" | null = null;
    while (!done) {
      const job = await json<Job>("GET", jobPath);
      if ((job.status?.succeeded ?? 0) > 0) done = "succeeded";
      else if ((job.status?.failed ?? 0) > 0) done = "failed";
      else if (now() >= deadline) return { exitCode: null, lines: await logLines(), timedOut: true };
      else await sleep(pollMs);
    }
    const pod = await findPod();
    const code: unknown = pod?.status?.containerStatuses?.[0]?.state?.terminated?.exitCode;
    const exitCode = typeof code === "number" ? code : done === "succeeded" ? 0 : null;
    return { exitCode, lines: await logLines(pod?.metadata?.name), timedOut: false };
  } finally {
    if (created) {
      try {
        await call("DELETE", `${jobPath}?propagationPolicy=Background`);
      } catch {
        // nothing more can be done; ttlSecondsAfterFinished reaps a finished Job
      }
    }
  }

  async function findPod(): Promise<Pod | undefined> {
    const list = await json<PodList>("GET", `/api/v1/namespaces/${ns}/pods?labelSelector=${encodeURIComponent(`job-name=${spec.name}`)}`);
    return list.items?.[0];
  }

  async function logLines(podName?: string): Promise<string[]> {
    try {
      const pod = podName ?? (await findPod())?.metadata?.name;
      if (typeof pod !== "string") return [];
      const res = await call("GET", `/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?limitBytes=${max}`);
      if (!res.ok || !res.body) return [];
      const text = await readCapped(res.body, max);
      return text.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1);
    } catch {
      return [];
    }
  }
}

/** Read a body chunk by chunk, stopping at `max` bytes; the rest is never held. */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.length > max - bytes ? value.subarray(0, max - bytes) : value;
      bytes += chunk.length;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
