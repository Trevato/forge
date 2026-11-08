/** The flow vitals (#5935): home, the tick line and the MCP `flow` tool read the same three numbers from seeded pulls. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { setTelemetryGrant, telemetryReader } from "../src/actions/telemetry.ts";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { flowVitals } from "../src/crew/autonomy.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { vitalsFor, vitalsLine, readVitals, vitalsMisses, vitalsWords, type Vitals } from "../src/flow/vitals.ts";

const NOW = new Date();
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("flow vitals", () => {
  test("home, the tick line and the MCP flow tool say the same numbers", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-vitals-"));
    const app = createApp({ dataDir: root, port: 0 });
    const servers = await serve(app);
    try {
      const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "v", visibility: "public", description: "v" });
      if (!repo.ok) throw new Error(repo.error);
      const branch = repo.value.defaultBranch;
      let n = 0;
      const pull = (opened: string, merged: string | null, state: string) => {
        const issueId = id();
        n++;
        app.db
          .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7)`)
          .run(issueId, repo.value.id, n, `P${n}`, made.value.id, state, opened);
        app.db
          .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
          .run(issueId, branch, `b/${n}`, repo.value.id, merged);
        return issueId;
      };
      pull(ago(0.5), null, "open"); // open, opened in the hour
      const clash = pull(ago(3), null, "open"); // open, opened in 6 h, conflicted
      pull(ago(20), null, "open"); // open, old
      pull(ago(4), ago(0.2), "closed"); // landed in the hour
      pull(ago(30), ago(5), "closed"); // landed in 6 h only
      pull(ago(30), ago(10), "closed"); // landed long ago
      app.db
        .query(`INSERT INTO run (id, repo_id, kind, issue_id, state, reason, created_at) VALUES (?1, ?2, 'agent', ?3, 'queued', 'conflict', ?4)`)
        .run(id(), repo.value.id, clash, ago(1));

      const v = readVitals(app.db, NOW);
      expect(v).toEqual({ open: 3, opened1h: 1, landed1h: 1, opened6h: 3, landed6h: 2, conflicted: 1, red: 0, queued: 0, oldestApprovedHours: null, strandedUsd: 0, gateMinutes1h: 0, pullCheckMinutes1h: 0, batches6h: 0, redBatchRate: null });
      expect(vitalsMisses(v)).toEqual(["landed 2 < opened 3 over 6 h"]);

      const tick = flowVitals(app.db, NOW);
      expect(tick.pulls).toBe("open 3, opened/landed 1/1 in 1 h, 3/2 in 6 h, conflicted 1, 0 red, 0 queued, $0.00 stranded, gate 0 min, other checks 0 min in 1 h");
      expect(tick.pulls).toBe(vitalsWords(v));
      expect(tick.offTarget).toBe("landed 2 < opened 3 over 6 h");

      const mcp = flowFor(app, { kind: "owner" } as Parameters<typeof flowFor>[1], NOW).vitals;
      expect(mcp).toMatchObject(v);
      expect(mcp.says).toContain("3 open pulls");

      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
      // Home no longer carries the line (#8015): it is the tick line and the flow tool.
      expect(await (await fetch(`${servers.url}/`, { headers: { cookie } })).text()).not.toContain("open pulls</a>");
    } finally {
      await servers.stop();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an agent reads public repositories alone; the owner reads all", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-vitals-"));
    const app = createApp({ dataDir: root, port: 0 });
    try {
      const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      let n = 0;
      for (const visibility of ["public", "private"] as const) {
        const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: visibility, visibility, description: "v" });
        if (!repo.ok) throw new Error(repo.error);
        for (const merged of [null, ago(0.2)]) {
          const issueId = id();
          n++;
          app.db
            .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7)`)
            .run(issueId, repo.value.id, n, `P${n}`, made.value.id, merged === null ? "open" : "closed", ago(0.5));
          app.db
            .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
            .run(issueId, repo.value.defaultBranch, `b/${n}`, repo.value.id, merged);
        }
      }
      const owner = flowFor(app, { kind: "owner" } as Parameters<typeof flowFor>[1], NOW).vitals;
      const agent = flowFor(app, { kind: "agent" } as Parameters<typeof flowFor>[1], NOW).vitals;
      expect(owner).toMatchObject({ open: 2, opened1h: 4, landed1h: 2 });
      expect(agent).toMatchObject({ open: 1, opened1h: 2, landed1h: 1 });
      // The terminal's Flow dialog says the same: whole for the owner, public alone for an agent.
      expect(flowLines(app.db, NOW).join(" ").replace(/\s+/g, " ")).toContain(vitalsLine(owner));
      const cut = flowLines(app.db, NOW, [], { queues: [] }).join(" ").replace(/\s+/g, " ");
      expect(cut).toContain(vitalsLine(agent));
      expect(cut).not.toContain(vitalsLine(owner));
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an empty forge reads zeros and misses nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-vitals-"));
    const app = createApp({ dataDir: root, port: 0 });
    try {
      const v = readVitals(app.db, NOW);
      expect(Object.values(v)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, 0, 0, null]);
      expect(vitalsMisses(v)).toEqual([]);
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an approved pull waiting over 24 h is a miss; an agent without telemetry:read gets no dollars", () => {
    const base: Vitals = { open: 1, opened1h: 0, landed1h: 0, opened6h: 0, landed6h: 0, conflicted: 0, red: 2, queued: 3, oldestApprovedHours: 30.4, strandedUsd: 12.5, gateMinutes1h: 0, pullCheckMinutes1h: 0, batches6h: 0, redBatchRate: null };
    expect(vitalsMisses(base)).toEqual(["oldest approved pull has waited 30 h"]);
    expect(vitalsMisses({ ...base, oldestApprovedHours: 24 })).toEqual([]);
    expect(vitalsMisses({ ...base, oldestApprovedHours: null })).toEqual([]);
    expect(vitalsWords(base)).toContain("2 red, 3 queued, oldest approved 30 h, $12.50 stranded");
    const cut = vitalsFor(base, false);
    expect("strandedUsd" in cut).toBe(false);
    expect(vitalsLine(cut)).not.toContain("stranded");
    expect(vitalsLine(cut)).toContain("2 red, 3 queued · oldest approved 30 h");
    expect(vitalsFor(base, true).strandedUsd).toBe(12.5);
  });

  test("a red-batch rate over 30% of at least 3 batches is a miss; the gate minutes are said", () => {
    const base: Vitals = { open: 1, opened1h: 0, landed1h: 0, opened6h: 0, landed6h: 0, conflicted: 0, red: 0, queued: 0, oldestApprovedHours: null, strandedUsd: 0, gateMinutes1h: 12.4, pullCheckMinutes1h: 30, batches6h: 4, redBatchRate: 0.5 };
    expect(vitalsMisses(base)).toEqual(["50% of merge batches went red in 6 h"]);
    expect(vitalsMisses({ ...base, batches6h: 10, redBatchRate: 0.3 })).toEqual([]);
    expect(vitalsMisses({ ...base, batches6h: 10, redBatchRate: 0.4 })).toEqual(["40% of merge batches went red in 6 h"]);
    expect(vitalsMisses({ ...base, batches6h: 2, redBatchRate: 1 })).toEqual([]);
    expect(vitalsMisses({ ...base, batches6h: 3, redBatchRate: 1 })).toHaveLength(1);
    expect(vitalsMisses({ ...base, batches6h: 0, redBatchRate: null })).toEqual([]);
    expect(vitalsWords(base)).toContain("gate 12 min, other checks 30 min in 1 h, 50% of 4 batches red in 6 h");
    expect(vitalsLine(base)).toContain("gate 12 min, other checks 30 min in 1 h · 50% of 4 batches red in 6 h");
  });

  test("the dollars and the old approval pass through every door only to a reader who may read them", async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-vitals-"));
    const app = createApp({ dataDir: root, port: 0 });
    try {
      const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      const repo = await createRepo(app.db, app.reposRoot, { ownerId: made.value.id, name: "g", visibility: "public", description: "g" });
      if (!repo.ok) throw new Error(repo.error);
      const issueId = id();
      app.db
        .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 1, 'pull', 'P', '', ?3, 'open', ?4)`)
        .run(issueId, repo.value.id, made.value.id, ago(50));
      app.db
        .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, 'b/1', '', '', ?3, NULL)`)
        .run(issueId, repo.value.defaultBranch, repo.value.id);
      app.db
        .query(`INSERT INTO run (id, repo_id, kind, issue_id, state, cost_usd, created_at) VALUES (?1, ?2, 'agent', ?3, 'ok', 3.5, ?4)`)
        .run(id(), repo.value.id, issueId, ago(40));
      app.db
        .query(`INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'approved', 'h', ?4)`)
        .run(id(), issueId, made.value.id, ago(30));

      // 1. flowFor: the dollars only for the owner and an agent that holds the grant.
      const read = (reader: object) => flowFor(app, reader as Parameters<typeof flowFor>[1], NOW).vitals;
      expect("strandedUsd" in read({ kind: "agent" })).toBe(false);
      expect(read({ kind: "agent" }).says).not.toContain("stranded");
      expect(read({ kind: "agent", spend: true }).strandedUsd).toBe(3.5);
      expect(read({ kind: "owner" }).strandedUsd).toBe(3.5);
      expect(read({ kind: "owner" }).says).toContain("$3.50 stranded");
      expect(read({ kind: "owner" }).misses).toContain("oldest approved pull has waited 30 h");

      // 2. telemetryReader marks a granted agent with spend, and refuses one without the grant.
      const bot = await createAgent(app, made.value, { username: "muse" });
      if (!bot.ok) throw new Error(String(bot.error));
      expect(telemetryReader(app, bot.value.user)).toBeUndefined();
      expect(setTelemetryGrant(app, made.value, "muse", true).ok).toBe(true);
      expect(telemetryReader(app, bot.value.user)).toEqual({ kind: "agent", spend: true });
      expect(telemetryReader(app, made.value)).toEqual({ kind: "owner" });

      // 3. The terminal: the owner's Flow dialog says it, an agent's does not.
      const text = (lines: string[]) => lines.join(" ").replace(/\s+/g, " ");
      expect(text(flowLines(app.db, NOW))).toContain("$3.50 stranded");
      expect(text(flowLines(app.db, NOW, [], { queues: [] }))).not.toContain("stranded");
      expect(text(flowLines(app.db, NOW, [], { queues: [] }))).toContain("oldest approved 30 h");

      // The tick line carries the same words, and the old approval is off target there.
      const tick = flowVitals(app.db, NOW);
      expect(tick.pulls).toContain("oldest approved 30 h");
      expect(tick.offTarget).toContain("oldest approved pull has waited 30 h");
    } finally {
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
