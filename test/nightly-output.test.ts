import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { JOBS } from "../src/nightly/jobs.ts";
import { filedIn, OUTPUT_CAP_BYTES, outputTail, readOutput, readsFiled, runPath, startOutput } from "../src/nightly/output.ts";
import { says } from "../src/nightly/service.ts";
import { writeLast } from "../src/nightly/stamps.ts";

describe("a nightly job's output", () => {
  test("what the hunt prints as it files is read back as what the run filed", () => {
    const lines = [
      "$ bun scripts/flake-hunt.ts outside --file-issues",
      "red  : test/a.test.ts",
      "  filed #12 for test/a.test.ts",
      "  updated #7 for test/b.test.ts",
      "  closed #4 for test/c.test.ts",
      "FLAKY test/d.test.ts: red 1, green 4; first red seed 9",
      "  filed #13",
      "  already open as #5",
      "quarantined test/d.test.ts (#13)",
      "nothing to quarantine",
    ];
    expect(filedIn(lines)).toEqual(["filed #12", "updated #7", "closed #4", "filed #13", "quarantined test/d.test.ts"]);
  });

  test("the lines filedIn reads are the ones scripts/flake-hunt.ts prints", () => {
    const script = readFileSync(join(import.meta.dir, "..", "scripts", "flake-hunt.ts"), "utf8");
    for (const printed of ["`  filed #${made.number} for ", "`  filed #${made.number}`", "`  updated #${action.number} for ", "`  closed #${action.number} for ", "`quarantined ${line}`"])
      expect(script).toContain(printed);
  });

  test("a run replaces the last one's output, and a run that prints too much is cut saying so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-out-"));
    try {
      expect(readOutput(dir, "outside-gate")).toBeUndefined();
      const first = startOutput(dir, "outside-gate");
      first.write("old night");
      await first.end();
      const next = startOutput(dir, "outside-gate");
      expect(readOutput(dir, "outside-gate")).toBe("");
      next.write("new night");
      await next.end();
      expect(readOutput(dir, "outside-gate")).toBe("new night\n");
      const big = "x".repeat(1000);
      for (let i = 0; i < OUTPUT_CAP_BYTES / 1000 + 10; i++) next.write(big);
      await next.end();
      const kept = readOutput(dir, "outside-gate")!;
      expect(kept.length).toBeLessThan(OUTPUT_CAP_BYTES + 100);
      expect(kept.endsWith(`… cut at ${OUTPUT_CAP_BYTES} bytes\n`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lines are written in batches, not one write each, and in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-out-"));
    try {
      const out = startOutput(dir, "flake-hunt");
      for (let i = 0; i < 100; i++) out.write(`line ${i}`);
      // Nothing has been written while the event loop was busy with the run.
      expect(readOutput(dir, "flake-hunt")).toBe("");
      await out.end();
      expect(readOutput(dir, "flake-hunt")).toBe(Array.from({ length: 100 }, (_, i) => `line ${i}\n`).join(""));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the tail is the last lines, read from the end of a long output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nightly-out-"));
    try {
      expect(outputTail(dir, "flake-hunt", 3)).toBeUndefined();
      const out = startOutput(dir, "flake-hunt");
      for (let i = 0; i < 5000; i++) out.write(`line ${i}`);
      await out.end();
      expect(outputTail(dir, "flake-hunt", 3)).toEqual(["line 4997", "line 4998", "line 4999"]);
      const all = outputTail(dir, "flake-hunt", 100_000)!;
      // Only the end of the file is read, and the line it cut through is dropped.
      expect(all.length).toBeLessThan(5000);
      expect(all[0]).toMatch(/^line \d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only the hunt script's steps are read for what they filed, never install", () => {
    for (const job of JOBS)
      for (const step of job.steps) expect([step.label, readsFiled(step)]).toEqual([step.label, step.command.startsWith("bun scripts/flake-hunt.ts ")]);
  });

  test("the record says what the run filed, or that it filed nothing", () => {
    expect(says({ dir: "x", oid: "y", failed: [], filed: [] }, undefined)).toBe("every step finished; filed nothing.");
    expect(says({ dir: "x", oid: "y", failed: ["hunt slice 2/20"], filed: ["filed #12", "quarantined test/a.test.ts"] }, "flake-hunt/2026-11-03")).toBe(
      "failed: hunt slice 2/20; filed #12, quarantined test/a.test.ts; quarantine pull on flake-hunt/2026-11-03.",
    );
  });
});

describe("the page a nightly issue links to", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "nightly-page-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!u.ok) throw new Error("users");
    }
    const kept = startOutput(dataDir, "outside-gate");
    kept.write("red  : test/<b>x</b>.test.ts");
    kept.write("  filed #12 for test/<b>x</b>.test.ts");
    await kept.end();
    writeLast(dataDir, "outside-gate", {
      slot: Date.parse("2026-11-03T03:47:00Z"),
      startedAt: Date.parse("2026-11-03T03:47:01Z"),
      finishedAt: Date.parse("2026-11-03T04:02:00Z"),
      says: "every step finished; filed #12.",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("an admin reads the run's record and its output, escaped, and Resilience links to it", async () => {
    const cookie = await login("alice");
    const res = await fetch(`${servers.url}${runPath("outside-gate")}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("every step finished; filed #12.");
    expect(text).toContain("filed #12 for test/&lt;b&gt;x&lt;/b&gt;.test.ts");
    expect(text).not.toContain("<b>x</b>");
    const resilience = await (await fetch(`${servers.url}/resilience`, { headers: { cookie } })).text();
    expect(resilience).toContain(`href="${runPath("outside-gate")}"`);
    expect(resilience).toContain(`href="${runPath("flake-hunt")}"`);
  });

  test("a job that has not run says so", async () => {
    const res = await fetch(`${servers.url}${runPath("flake-hunt")}`, { headers: { cookie: await login("alice") } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No output here yet");
  });

  test("anyone but an admin is refused, and any job that is not one is not found", async () => {
    expect((await fetch(`${servers.url}${runPath("outside-gate")}`, { headers: { cookie: await login("bob") } })).status).toBe(403);
    expect((await fetch(`${servers.url}${runPath("sync-env")}`, { headers: { cookie: await login("alice") } })).status).toBe(404);
    const anon = await fetch(`${servers.url}${runPath("outside-gate")}`, { redirect: "manual" });
    expect(anon.status).not.toBe(200);
    expect(await anon.text()).not.toContain("filed #12");
  });
});
