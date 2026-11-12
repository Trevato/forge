/**
 * A paused run says when it resumes, with the day when that is not today,
 * and the terminal's run row says it in the same words as the web card.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import { pausedNote, resumeText } from "../src/crew/pacing.ts";
import { runRows } from "../src/tui/screens/runlist.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const now = new Date("2026-11-12T10:00:00Z");

test("a resume later today reads as a time; on another day it carries the date", () => {
  expect(resumeText(new Date("2026-11-12T17:21:00Z"), now)).toBe("17:21 UTC");
  expect(resumeText(new Date("2026-11-13T07:21:00Z"), now)).toBe("2026-11-13 07:21 UTC");
  expect(pausedNote("2026-11-19T07:21:00Z", now)).toBe("paused, resumes 2026-11-19 07:21 UTC");
  expect(pausedNote("not a time", now)).toBe("paused, resumes soon");
});

const dir = await mkdtemp(join(tmpdir(), "forge-paused-note-"));
const forge = createApp({ dataDir: dir, port: 0 });
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
if (!a.ok) throw new Error("signup failed");
const r = await createRepo(forge, a.value, { name: "lamp", visibility: "public" });
if (!r.ok) throw new Error("repo failed");
const repoId = r.value.id;

test("the terminal's run row names a paused run's resume time; a plain queued run keeps its reason", () => {
  const run = createRun(forge.db, { repoId, kind: "agent", reason: "issue #4" });
  const notBefore = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const [paused, plain] = runRows(
    [
      { ...run, state: "queued", notBefore },
      { ...run, state: "queued", notBefore: null },
    ],
    new Map(),
  );
  expect(paused!.secondary).toBe(pausedNote(notBefore));
  expect(paused!.secondary).toContain(notBefore.slice(0, 10));
  expect(plain!.secondary).toBe(run.summary === "" ? run.reason : run.summary);
});
