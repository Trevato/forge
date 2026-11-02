/**
 * `bun scripts/pinned-canary.ts <forge url> --account <name> --app <owner/name> --source <https git url>
 *  --version <40-hex or vX.Y.Z> --next <second version> [--name <pinned name>] [--budget <seconds>]`
 *
 * The canary for pinned forges (#8746): one real Deploy, Update and Rollback
 * through the forge's admin API against a real cloud account, each step timed,
 * the whole run held to a budget (default 600 s). `FORGE_TOKEN` is an
 * admin-scope token of the forge that holds the cloud account (writes allowed);
 * the cloud token itself never passes through here. Prints the table to paste
 * into docs/features/pinned-forge.md ("Canary results") and exits 1 when a step
 * fails, a version is not the one asked for, or the budget is spent.
 *
 * It creates a droplet and a volume the driver cannot delete: remove them in
 * the cloud console afterwards (the report names the ids).
 */

export interface Step {
  readonly step: string;
  readonly seconds: number;
  readonly version: string;
  readonly state: string;
  readonly remote: string;
  readonly volume: string;
}

export interface Report {
  readonly steps: Step[];
  readonly total: number;
  readonly budget: number;
  readonly failure: string | undefined;
}

type Call = (path: string, body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** Run deploy, update, rollback through `call`; `now` is seconds (injected so a test needs no clock). */
export async function canary(
  call: Call,
  now: () => number,
  o: { name: string; account: string; app: string; source: string; version: string; next: string; budget: number },
): Promise<Report> {
  const steps: Step[] = [];
  const t0 = now();
  const plan: Array<[string, string, unknown, string]> = [
    ["deploy", "/api/v1/admin/pinned", { name: o.name, target: "digitalocean", account: o.account, app: o.app, source: o.source, version: o.version }, o.version],
    ["update", `/api/v1/admin/pinned/${o.name}/update`, { version: o.next }, o.next],
    ["rollback", `/api/v1/admin/pinned/${o.name}/rollback`, {}, o.version],
  ];
  const finish = (failure?: string): Report => ({ steps, total: now() - t0, budget: o.budget, failure });
  for (const [step, path, body, want] of plan) {
    const t = now();
    let r;
    try {
      r = await call(path, body);
    } catch (e) {
      return finish(`${step}: ${e instanceof Error ? e.message : "request failed"}`);
    }
    const s: Step = { step, seconds: now() - t, version: text(r.json.version), state: text(r.json.state), remote: text(r.json.remote), volume: text(r.json.volume) };
    steps.push(s);
    if (r.status >= 300) return finish(`${step}: HTTP ${r.status} ${text(r.json.message) || text(r.json.error)}`.trim());
    if (s.state !== "running") return finish(`${step}: state is "${s.state}", not running`);
    if (s.version !== want) return finish(`${step}: version is "${s.version}", wanted "${want}"`);
    if (!s.remote) return finish(`${step}: no droplet id recorded`);
  }
  const total = now() - t0;
  return finish(total > o.budget ? `took ${total.toFixed(0)} s, over the ${o.budget} s budget` : undefined);
}

const VERSION = /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/;

/** Refuse before any paid call: a version is a full commit id or vX.Y.Z; the source is https. */
export function invalid(o: { version: string; next: string; source: string }): string | undefined {
  if (!VERSION.test(o.version)) return "--version is a 40-character commit id or a tag like v1.2.3";
  if (!VERSION.test(o.next)) return "--next is a 40-character commit id or a tag like v1.2.3";
  if (o.version === o.next) return "--next must differ from --version, or the Update changes nothing";
  try {
    if (new URL(o.source).protocol !== "https:") return "--source must be https";
  } catch {
    return "--source must be an https URL";
  }
  return undefined;
}

/** What a failed run may have left billing: every droplet and volume id the steps recorded. */
export function leftovers(r: Report): string {
  const droplets = [...new Set(r.steps.map((s) => s.remote).filter(Boolean))];
  const volumes = [...new Set(r.steps.map((s) => s.volume).filter(Boolean))];
  return `droplets: ${droplets.join(", ") || "none recorded"}; volumes: ${volumes.join(", ") || "none recorded"}`;
}

/** The table for the doc: step, seconds, version, droplet, volume. */
export function table(r: Report): string {
  const rows = r.steps.map((s) => `| ${s.step} | ${s.seconds.toFixed(1)} | ${s.version.slice(0, 12)} | ${s.remote} | ${s.volume} |`);
  return [
    "| Step | Seconds | Version | Droplet | Volume |",
    "|---|---|---|---|---|",
    ...rows,
    `| **total** | **${r.total.toFixed(1)}** (budget ${r.budget}) | | | |`,
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(n);
    return i < 0 ? undefined : args[i + 1];
  };
  const base = args[0];
  const token = process.env.FORGE_TOKEN;
  const [account, app, source, version, next] = ["--account", "--app", "--source", "--version", "--next"].map(flag);
  const budget = Number(flag("--budget") ?? 600);
  if (!base?.startsWith("http") || !token || !account || !app || !source || !version || !next || !(budget > 0)) {
    console.error("usage: FORGE_TOKEN=<admin token> bun scripts/pinned-canary.ts <forge url> --account <n> --app <owner/name> --source <https url> --version <v> --next <v2> [--name <n>] [--budget <s>]");
    process.exit(2);
  }
  const call: Call = async (path, body) => {
    const res = await fetch(new URL(path, base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const refused = invalid({ version, next, source });
  if (refused) {
    console.error(refused);
    process.exit(2);
  }
  const name = flag("--name") ?? `canary-${new Date().toISOString().slice(0, 19).replace(/\D/g, "").replace(/^(\d{8})/, "$1-")}`;
  const report = await canary(call, () => performance.now() / 1000, { name, account, app, source, version, next, budget });
  console.log(table(report));
  if (report.failure) {
    console.error(`FAILED: ${report.failure}\nStill billing, remove in the cloud console: ${leftovers(report)}`);
    process.exit(1);
  }
}
