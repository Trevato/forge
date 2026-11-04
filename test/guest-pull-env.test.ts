/**
 * A guest pull's processes, end to end (#9018): a pull whose author lives on
 * another forge runs its real check and its real preview here, and what each
 * process holds is read from the process itself, not from the function that
 * builds it. The check holds none of the app's variables and no forge token,
 * before a writer approves the guest and after: a check never carries the
 * repository's secrets (`checks/service.ts` names its environment from the
 * forge's own words, through `childEnv`). The preview holds neither until a
 * writer approves, then both (`AppsRuntime.secretsFor`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newApp } from "../src/actions/apps.ts";
import { approveGuestPull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { setAppEnv } from "../src/core/app_env.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { guestWaits } from "../src/origins/guest.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  deploySettled,
  fetchAsHost,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SECRET = "s3cret-9018";

/** The app: a check that prints its whole environment, a server that says what it holds. */
const FILES = [
  {
    path: "forge.json",
    content: `${JSON.stringify({
      app: { run: "bun run src/server.ts", health: "/healthz" },
      check: { run: "env", install: "" },
    })}\n`,
  },
  {
    path: "src/server.ts",
    content: `Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch() {
    return Response.json({
      apiKey: process.env.API_KEY ?? null,
      forgeToken: (process.env.FORGE_TOKEN ?? "") !== "",
    });
  },
});
`,
  },
];

describe("a guest pull's check and preview, read from the processes themselves", () => {
  let forge: AppsForge;
  let checks: ChecksHandle;
  let repo: Repo;
  let slug: string;

  async function checkSettled(env: string, commitOid: string): Promise<Run> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = listRuns(forge.app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.env === env && r.commitOid === commitOid,
      );
      if (run !== undefined && (run.state === "ok" || run.state === "failed" || run.state === "cancelled"))
        return run;
      await Bun.sleep(100);
    }
    throw new Error(`the check of ${commitOid.slice(0, 7)} did not settle`);
  }

  /** What the check's process printed of its environment. */
  const checkLog = (run: Run) => readRunLog(forge.dataDir, run.id).lines.join("\n");

  async function heldByPreview(pull: Pull): Promise<{ apiKey: string | null; forgeToken: boolean }> {
    const res = await fetchAsHost(forge.servers, `${slug}--${pull.number}.${forge.runtime.options.domain}`, "/", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { apiKey: string | null; forgeToken: boolean };
  }

  beforeAll(async () => {
    forge = await startAppsForge();
    checks = startChecks(forge.app, { forgeUrl: forge.servers.url, concurrency: 1 });
    const made = await newApp(forge.app, forge.alice, {
      name: "vault",
      description: "Holds a key",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    slug = made.value.app.slug;
    const set = setAppEnv(forge.app.db, forge.dataDir, made.value.app.id, "API_KEY", SECRET);
    if (!set.ok) throw new Error(set.error);
    const committed = await commitToBranch(forge.app, forge.alice, repo, {
      message: "Say what it holds",
      files: FILES,
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const prod = await deploySettled(
      forge.app,
      repo.id,
      (r) => r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    if (prod.state !== "ok") throw new Error(prod.summary);
  }, 120_000);

  afterAll(async () => {
    await checks.stop();
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("the check holds nothing secret before or after approval; the preview holds the secrets only after", async () => {
    const { app, alice } = forge;
    const branch = "from-elsewhere";
    const first = await commitToBranch(app, alice, repo, {
      branch,
      message: "From another forge",
      files: [{ path: "theirs.md", content: "one\n" }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    // The pull is born a guest, as one brought in from the origin is: its
    // issue names an origin author before its check or preview is asked for.
    app.db.run(
      `CREATE TEMP TRIGGER guest_at_birth AFTER INSERT ON issue WHEN NEW.kind = 'pull'
       BEGIN UPDATE issue SET origin_author = 'octocat' WHERE id = NEW.id; END`,
    );
    let pull: Pull;
    try {
      const opened = await openPull(app, alice, repo, {
        title: "Theirs",
        baseBranch: "main",
        headBranch: branch,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      pull = getPull(app.db, repo.id, opened.value.number)!;
    } finally {
      app.db.run("DROP TRIGGER guest_at_birth");
    }
    expect(guestWaits(app.db, pull)).toBe(true);
    const env = `pull-${pull.number}`;

    // Waiting: the check ran and printed its environment, none of it secret.
    const before = await checkSettled(env, first.value.commitOid);
    expect(before.state).toBe("ok");
    const printed = checkLog(before);
    expect(printed).toContain(`FORGE_CHECK=${before.id}`);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain("API_KEY=");
    expect(printed).not.toContain("FORGE_TOKEN=");
    const waiting = await deploySettled(app, repo.id, (r) => r.env === env && r.commitOid === first.value.commitOid);
    expect(waiting.state).toBe("ok");
    expect(await heldByPreview(pull)).toEqual({ apiKey: null, forgeToken: false });

    // A writer approves: the preview starts again holding both.
    expect(approveGuestPull(app, alice, repo, pull)).toEqual({ ok: true, value: "approved" });
    const restarted = await deploySettled(app, repo.id, (r) => r.env === env && r.id !== waiting.id);
    expect(restarted.state).toBe("ok");
    expect(await heldByPreview(pull)).toEqual({ apiKey: SECRET, forgeToken: true });

    // The guest pushes again: its check still holds nothing secret, by
    // design, while its preview keeps the approval.
    const second = await commitToBranch(app, alice, repo, {
      branch,
      message: "And more",
      files: [{ path: "theirs.md", content: "two\n" }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const after = await checkSettled(env, second.value.commitOid);
    expect(after.state).toBe("ok");
    const printedAfter = checkLog(after);
    expect(printedAfter).toContain(`FORGE_CHECK=${after.id}`);
    expect(printedAfter).not.toContain(SECRET);
    expect(printedAfter).not.toContain("API_KEY=");
    expect(printedAfter).not.toContain("FORGE_TOKEN=");
    const pushed = await deploySettled(app, repo.id, (r) => r.env === env && r.commitOid === second.value.commitOid);
    expect(pushed.state).toBe("ok");
    expect(await heldByPreview(pull)).toEqual({ apiKey: SECRET, forgeToken: true });
  }, 180_000);
});
