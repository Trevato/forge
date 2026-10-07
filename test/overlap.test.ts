/**
 * Two forge processes on one data directory, as during a roll (#875): what
 * either may start, it starts once. Two real processes — one process alone
 * cannot interleave two callers between a check and an insert — race to
 * queue the crew on the same issues in the same order, and every issue ends
 * with exactly one run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import {
  CLAIM_MS,
  createWebhook,
  DELIVER_TIMEOUT_MS,
  deliverDue,
} from "../src/core/webhooks.ts";
import { serve } from "../src/http/server.ts";
import { drainStreams } from "../src/http/sse.ts";

const ISSUES = Number(process.env["FORGE_OVERLAP_ISSUES"] ?? 400);

describe("two processes on one data directory start each run once", () => {
  let dataDir: string;
  let app: App;
  let repoId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-overlap-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const bot = await createAgent(app, a.value, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    const made = await createRepo(app, a.value, { name: "garden", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, a.value, made.value, "bot").ok).toBe(true);
    repoId = made.value.id;
    for (let n = 1; n <= ISSUES; n++) {
      const issue = openIssue(app, a.value, made.value, { title: `Tend bed ${n}` });
      if (!issue.ok) throw new Error(String(issue.error));
    }
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the crew is queued on each issue once, whichever process asks", async () => {
    const startAt = String(Date.now() + 1500);
    const worker = join(import.meta.dir, "helpers", "overlap-worker.ts");
    const spawn = () =>
      Bun.spawn([process.execPath, worker, "queue", dataDir, startAt, String(ISSUES)], {
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
      });
    const [one, two] = [spawn(), spawn()];
    const [a = 0, b = 0] = await Promise.all(
      [one, two].map(async (p) => {
        const out = await new Response(p.stdout).text();
        expect(await p.exited).toBe(0);
        return Number(out.trim().split("\n").at(-1));
      }),
    );
    const perIssue = app.db
      .query(
        "SELECT issue_id, count(*) AS n FROM run WHERE kind = 'agent' GROUP BY issue_id",
      )
      .all() as { issue_id: string; n: number }[];
    expect(perIssue.length).toBe(ISSUES);
    expect(perIssue.filter((r) => r.n !== 1)).toEqual([]);
    expect(a + b).toBe(ISSUES);
  }, 120_000);

  test("a webhook delivery due in both processes is sent once", async () => {
    const hits = new Map<string, number>();
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        const id = request.headers.get("x-forge-delivery") ?? (await request.text());
        hits.set(id, (hits.get(id) ?? 0) + 1);
        return new Response("ok");
      },
    });
    try {
      const made = createWebhook(app.db, {
        repoId,
        url: `http://127.0.0.1:${receiver.port}/hook`,
        kinds: "",
      });
      if (!made.ok) throw new Error(String(made.error));
      for (let n = 0; n < 60; n++)
        app.bus.append({ kind: "push", repoId, payload: { n } });
      const pending = (
        app.db
          .query("SELECT count(*) AS n FROM webhook_delivery WHERE state = 'pending'")
          .get() as { n: number }
      ).n;
      expect(pending).toBe(60);
      const startAt = String(Date.now() + 1500);
      const worker = join(import.meta.dir, "helpers", "overlap-worker.ts");
      const spawn = () =>
        Bun.spawn([process.execPath, worker, "deliver", dataDir, startAt, "0"], {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
        });
      const sent = await Promise.all(
        [spawn(), spawn()].map(async (p) => {
          const out = await new Response(p.stdout).text();
          expect(await p.exited).toBe(0);
          return Number(out.trim().split("\n").at(-1));
        }),
      );
      const total = [...hits.values()].reduce((a, b) => a + b, 0);
      expect(total).toBe(60);
      expect([...hits.values()].every((n) => n === 1)).toBe(true);
      expect((sent[0] ?? 0) + (sent[1] ?? 0)).toBeGreaterThanOrEqual(60);
    } finally {
      receiver.stop(true);
    }
  }, 120_000);

  test("a claim taken late in a slow batch does not lapse while its row is sent", async () => {
    expect(CLAIM_MS).toBeGreaterThan(DELIVER_TIMEOUT_MS);
    app.db.run("DELETE FROM webhook_delivery");
    app.db.run("DELETE FROM webhook");
    const hits = new Map<string, number>();
    const receiver = Bun.serve({
      port: 0,
      async fetch(request) {
        const id = request.headers.get("x-forge-delivery") ?? "";
        hits.set(id, (hits.get(id) ?? 0) + 1);
        await Bun.sleep(300);
        return new Response("ok");
      },
    });
    try {
      const made = createWebhook(app.db, {
        repoId,
        url: `http://127.0.0.1:${receiver.port}/slow`,
        kinds: "",
      });
      if (!made.ok) throw new Error(String(made.error));
      for (let n = 0; n < 4; n++)
        app.bus.append({ kind: "push", repoId, payload: { slow: n } });
      // A batch that began a while ago, as one behind a slow endpoint has:
      // its claims must still be leased from the moment each is taken.
      const behind = deliverDue(app.db, app.log, new Date(Date.now() - 2 * CLAIM_MS));
      await Bun.sleep(100);
      const beside = deliverDue(app.db, app.log);
      await Promise.all([behind, beside]);
      expect(hits.size).toBe(4);
      expect([...hits.values()].every((n) => n === 1)).toBe(true);
    } finally {
      receiver.stop(true);
    }
  });

  test("a draining process ends its open streams with a resume hint", async () => {
    const servers = await serve(app);
    try {
      const stream = await fetch(`${servers.url}/events`);
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      await reader.read();
      expect(drainStreams()).toBeGreaterThan(0);
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("retry: 1000");
      expect(text).toContain("event: drain");
    } finally {
      servers.stop();
    }
  });
});
