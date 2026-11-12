/**
 * How a run reads in the terminal (#7594): every state's tone, the
 * environment in words, the dollars to the cent — and the runs list and the
 * run log saying the same words for one run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { RUN_STATES, claimRun, createRun, finishRun, type Run, type RunState } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { runLogScreen } from "../src/tui/screens/runlog.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { costText, envLabel, runTone } from "../src/tui/screens/runwords.ts";
import type { Screen } from "../src/tui/app/app.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { Tone } from "../src/tui/ui/widgets.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

/**
 * The tone each state wears. A `Record` over `RunState`, so a state added to
 * `RUN_STATES` without a row here fails the type check, and the loop below
 * fails the test. `queued` has no tone on purpose: nothing has happened yet.
 */
const TONES: Record<RunState, Tone | undefined> = {
  queued: undefined,
  running: "attn",
  ok: "success",
  failed: "danger",
  cancelled: "secondary",
};

describe("runTone", () => {
  test("RUN_STATES names each state once", () => {
    expect(new Set(RUN_STATES).size).toBe(RUN_STATES.length);
    expect(RUN_STATES.length).toBeGreaterThan(0);
  });

  for (const state of RUN_STATES) {
    test(`${state} wears its tone`, () => {
      expect(Object.hasOwn(TONES, state)).toBe(true);
      expect(runTone(state)).toBe(TONES[state]);
    });
  }

  test("only a queued run goes without a tone", () => {
    expect(RUN_STATES.filter((s) => runTone(s) === undefined)).toEqual(["queued"]);
  });
});

describe("envLabel", () => {
  test("a pull's environment reads as the pull", () => {
    expect(envLabel("pull-4")).toBe("pull #4");
    expect(envLabel("pull-7594")).toBe("pull #7594");
  });
  test("a named environment reads as its name", () => {
    expect(envLabel("production")).toBe("production");
  });
  test("no environment reads as a dash", () => {
    expect(envLabel("")).toBe("—");
  });
});

describe("costText", () => {
  test("zero spent says nothing", () => {
    expect(costText(0)).toBe("");
  });
  // Rounded to the cent, as the web studio cards and the runner's line do:
  // a sub-cent run reads $0.00, not nothing, because it did spend.
  test("sub-cent rounds to the cent", () => {
    expect(costText(0.004)).toBe("$0.00");
    expect(costText(0.005)).toBe("$0.01");
  });
  test("cents read to the cent", () => {
    expect(costText(0.07)).toBe("$0.07");
    expect(costText(0.4)).toBe("$0.40");
    expect(costText(3.456)).toBe("$3.46");
  });
  test("thousands read whole, to the cent, with no separator", () => {
    expect(costText(1234.5)).toBe("$1234.50");
    expect(costText(12000)).toBe("$12000.00");
  });
});

describe("the runs list and the run log read one run alike", () => {
  let dir: string;
  let forge: Forge;
  let repo: Repo;
  let alice: User;
  let run: Run;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-tui-runwords-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    repo = r.value;
    run = createRun(forge.db, { repoId: repo.id, kind: "deploy", env: "pull-4" });
    claimRun(forge.db, run.id);
    finishRun(forge.db, run.id, { state: "failed", summary: "LAMP-BROKE", costUsd: 1234.5 });
  });
  afterAll(async () => {
    forge.close?.();
    await rm(dir, { recursive: true, force: true });
  });

  const draw = async (screen: (f: Parameters<typeof runsScreen>[0], ctx: Parameters<typeof runsScreen>[1]) => Screen) => {
    const { app, session } = createForgeApp(
      forge,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
      { terminal: headlessTerminal(140, 20), exitHooks: false },
    );
    app.start();
    await settleApp(app);
    app.push(screen(session, app.ctx));
    await settleApp(app);
    const text = app.screen.toText();
    app.stop();
    return text;
  };

  test("both say the state, the environment and the dollars in the same words", async () => {
    const list = await draw((f, ctx) => runsScreen(f, ctx, repo));
    const log = await draw((f, ctx) => runLogScreen(f, ctx, repo, run.id));
    for (const words of ["failed", "deploy pull #4", "$1234.50", "LAMP-BROKE"]) {
      expect(list).toContain(words);
      expect(log).toContain(words);
    }
  });
});
