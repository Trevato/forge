import { expect, test } from "bun:test";
import { manifest, runJob, serviceAccount, type JobSpec } from "../src/cluster/jobs.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const spec: JobSpec = { name: "build-1", image: "alpine:3", command: ["sh", "-c", "echo hi"], env: { A: "b" }, nodeSelector: { pool: "ci" }, tolerations: [{ key: "ci", operator: "Exists" }] };
const credentials = { server: "https://k", token: "tok", ca: "CA", namespace: "forge" };

/** A stand-in kube API: `phases` is what successive Job GETs report. */
function kube(phases: object[], exit = 0, log = "one\ntwo\n") {
  const calls: { method: string; url: string; auth: string | null; body?: string }[] = [];
  let i = 0;
  const fetch = async (url: string, init: any) => {
    calls.push({ method: init.method, url, auth: new Headers(init.headers).get("authorization"), body: init.body });
    const path = new URL(url).pathname;
    if (init.method === "POST") return Response.json({});
    if (init.method === "DELETE") return Response.json({});
    if (path.endsWith("/log")) return new Response(log);
    if (path.endsWith("/pods")) return Response.json({ items: [{ metadata: { name: "p1" }, status: { containerStatuses: [{ state: { terminated: { exitCode: exit } } }] } }] });
    return Response.json({ status: phases[Math.min(i++, phases.length - 1)] });
  };
  return { fetch, calls };
}
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
const deleted = (c: { method: string }[]) => c.filter((x) => x.method === "DELETE").length;

test("a Job succeeds: exit code and log lines come back, the Job is deleted", async () => {
  const k = kube([{}, { succeeded: 1 }]);
  const r = await runJob(spec, { fetch: k.fetch, credentials, ...clock() });
  expect(r).toEqual({ exitCode: 0, lines: ["one", "two"], timedOut: false });
  expect(deleted(k.calls)).toBe(1);
  expect(k.calls.every((c) => c.auth === "Bearer tok")).toBe(true);
  const sent = JSON.parse(k.calls[0]!.body!);
  expect(sent.spec.template.spec.nodeSelector).toEqual({ pool: "ci" });
  expect(sent.spec.template.spec.containers[0].env).toEqual([{ name: "A", value: "b" }]);
});

test("a Job fails: the container's exit code is reported, the Job is deleted", async () => {
  const k = kube([{ failed: 1 }], 3);
  const r = await runJob(spec, { fetch: k.fetch, credentials, ...clock() });
  expect(r.exitCode).toBe(3);
  expect(r.timedOut).toBe(false);
  expect(deleted(k.calls)).toBe(1);
});

test("a Job that outlives the deadline times out and is deleted", async () => {
  const k = kube([{ active: 1 }]);
  const r = await runJob(spec, { fetch: k.fetch, credentials, timeoutMs: 3000, pollMs: 1000, ...clock() });
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBeNull();
  expect(deleted(k.calls)).toBe(1);
});

test("an API error still deletes the Job", async () => {
  const calls: string[] = [];
  const fetch = async (_u: string, init: any) => { calls.push(init.method); return init.method === "DELETE" ? Response.json({}) : new Response("no", { status: 500 }); };
  await expect(runJob(spec, { fetch, credentials, ...clock() })).rejects.toThrow("kube POST 500");
  expect(calls).toEqual(["POST", "DELETE"]);
});

test("a bad spec is refused before any call", async () => {
  const k = kube([{}]);
  await expect(runJob({ ...spec, name: "Bad Name" }, { fetch: k.fetch, credentials })).rejects.toThrow("DNS label");
  expect(() => manifest({ ...spec, env: { "a b": "x" } })).toThrow("bad env");
  expect(() => manifest({ ...spec, command: [] })).toThrow("command");
  expect(k.calls).toHaveLength(0);
});

test("the service account is read from the standard files", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "sa-"));
  for (const [f, v] of [["token", "t\n"], ["ca.crt", "C"], ["namespace", "ns"]]) writeFileSync(join(dir, f!), v!);
  expect(serviceAccount(dir, { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "6443" })).toEqual({ server: "https://10.0.0.1:6443", token: "t", ca: "C", namespace: "ns" });
  expect(() => serviceAccount(dir, {})).toThrow("cluster");
});

test("a create answering 409 deletes nothing: the Job is another run's", async () => {
  const calls: string[] = [];
  const fetch = async (_u: string, init: any) => { calls.push(init.method); return new Response("exists", { status: 409 }); };
  await expect(runJob(spec, { fetch, credentials, ...clock() })).rejects.toThrow("kube POST 409");
  expect(calls).toEqual(["POST"]);
});

test("a log larger than the cap comes back truncated, by bytes, and is asked for bounded", async () => {
  const k = kube([{ succeeded: 1 }], 0, "é".repeat(50) + "\nlast\n");
  const r = await runJob(spec, { fetch: k.fetch, credentials, maxLogBytes: 10, ...clock() });
  expect(r.lines).toEqual(["ééééé"]);
  expect(k.calls.some((c) => c.url.endsWith("/log?limitBytes=10"))).toBe(true);
});
