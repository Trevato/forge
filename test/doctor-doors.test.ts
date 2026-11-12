/**
 * The batch doctor's runs are reachable (#7555): the flow panel, the terminal Flow dialog and MCP `queue_gates`
 * each show them, and none tells a guest or a sealed pull's probe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { treatRed } from "../src/checks/doctor.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { doctorLines, flowLines } from "../src/tui/screens/flow.ts";
import { doctorWorld, redFor, type Doctor } from "./helpers/doctor.ts";

describe("the batch doctor's runs are reachable", () => {
  let w: Doctor;
  let servers: Servers;
  let pullNumber = 0;
  beforeAll(async () => {
    w = await doctorWorld("doors");
    servers = await serve(w.app);
    const pull = await w.pull("bad.ts");
    pullNumber = pull.number;
    treatRed(w.app, w.repo, w.alice, pull, redFor("adds two", "test/add.test.ts", "error: expected 3 got 4"), "c".repeat(40));
  });
  afterAll(async () => {
    servers.stop();
    await w.close();
  });

  const login = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const mcp = async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(w.app.db, w.alice.id, "t", "ro").token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "queue_gates", arguments: { repo: "alice/doors" } } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).not.toBe(true);
    return JSON.parse(body.result.content[0]!.text) as { doctor: { culprit: number | null; batch: string; action: string; class: string; probe: string; sealed: boolean }[] };
  };
  const seal = (on: number) => w.app.db.query("UPDATE issue SET sealed = ?2 WHERE repo_id = ?1 AND number = ?3").run(w.repo.id, on, pullNumber);

  test("the flow panel lists it for the owner and not for a guest", async () => {
    const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie: await login() } })).text();
    expect(page).toContain("Batch doctor");
    expect(page).toContain(`/alice/doors/pulls/${pullNumber}`);
    expect(page).toContain("expected 3 got 4");
    const guest = await (await fetch(`${servers.url}/boards`)).text();
    expect(guest).not.toContain("alice/doors");
    expect(guest).not.toContain("expected 3 got 4");
  });

  test("the terminal Flow dialog lists it under the repository's queue line", () => {
    const queues = [{ repo: "alice/doors", queued: 1, gating: 0, gates: 0, landedHour: 0, approvedToLanded: null }];
    const lines = flowLines(w.app.db, new Date(), [], { queues }, []);
    expect(lines.some((l) => l.startsWith(`  doctor #${pullNumber} held · functional`))).toBe(true);
  });

  test("MCP queue_gates carries it, and a read-only token may read it", async () => {
    const { doctor } = await mcp();
    expect(doctor[0]).toMatchObject({ culprit: pullNumber, action: "held", class: "functional", sealed: false });
    expect(doctor[0]!.probe).toContain("expected 3 got 4");
  });

  test("a sealed culprit is named by no door and its probe is blank", async () => {
    seal(1);
    try {
      const { doctor } = await mcp();
      expect(doctor[0]).toMatchObject({ sealed: true, probe: "", culprit: null, batch: "" });
      expect(JSON.stringify(doctor)).not.toContain(`"culprit":${pullNumber}`);
      const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie: await login() } })).text();
      expect(page).toContain("a sealed pull");
      expect(page).not.toContain("expected 3 got 4");
      const lines = doctorLines(doctor.map((d) => ({ ...d, at: new Date().toISOString() })), Date.now(), 70);
      expect(lines[0]).toContain("a sealed pull");
      expect(lines[0]).not.toContain("expected 3 got 4");
    } finally {
      seal(0);
    }
  });
});
