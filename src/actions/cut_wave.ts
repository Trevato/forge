/**
 * Cut a wave: an admin opens a draft `waves/<next>.md` as a pull listing
 * every pull merged since the last wave (`story/cut.ts` plans it). The
 * earlier waves are read from the default branch; one that does not parse
 * stops the cut, named, and nothing is written. No model is called.
 */

import type { App } from "../app.ts";
import { canAdmin, type Repo } from "../core/repos.ts";
import { mergedPullsSince } from "../core/pulls.ts";
import type { User } from "../core/users.ts";
import { listTree, readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { cutWave, type Cut, type WaveFile } from "../story/cut.ts";
import { editFiles } from "./contents.ts";

export interface CutDone {
  readonly version: string;
  readonly number: number;
}

/** The waves on the default branch, as files. */
async function readWaves(app: App, repo: Repo): Promise<WaveFile[]> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tree = await listTree(dir, repo.defaultBranch, "waves");
  if (!tree.ok) return [];
  const files: WaveFile[] = [];
  for (const e of tree.value) {
    if (e.type !== "blob" || !e.name.endsWith(".md")) continue;
    const obj = await readerFor(dir).object(e.oid);
    const text = obj.ok ? new TextDecoder().decode(obj.value.body) : "";
    files.push({ path: `waves/${e.name}`, text });
  }
  return files;
}

/** What a cut would write, or the reason it cannot; nothing is written. */
export async function planCutFor(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<Cut, string>> {
  if (!actor || actor.kind === "agent" || !canAdmin(app.db, repo, actor))
    return err("Only a repository admin can cut a wave.");
  const waves = await readWaves(app, repo);
  const base = app.config.url ?? `http://localhost:${app.config.port}`;
  const repoUrl = `${base.replace(/\/+$/, "")}/${repo.ownerName}/${repo.name}`;
  const plan = cutWave({
    waves,
    merged: (since) =>
      mergedPullsSince(app.db, repo.id, since === "" ? null : since).map((p) => ({
        number: p.number,
        title: p.title,
        mergedAt: p.mergedAt ?? "",
        headBranch: p.headBranch,
      })),
    today: new Date().toISOString().slice(0, 10),
    link: (n) => `${repoUrl}/pulls/${n}`,
  });
  return plan.ok ? ok(plan.value) : err(plan.error);
}

/** The reason is a plain sentence, ready to show. */
export async function cutWaveFor(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Promise<Result<CutDone, string>> {
  const plan = await planCutFor(app, actor, repo);
  if (!plan.ok) return err(plan.error);
  const { version, path, text, pulls } = plan.value;
  const edited = await editFiles(app, actor, repo, {
    newBranch: `wave/${version}`,
    message: `Wave ${version}: ${pulls} merged pulls`,
    files: [{ path, content: text }],
    openPull: {
      title: `Wave ${version}`,
      body: `A draft of ${path}, listing ${pulls} merged pull${pulls === 1 ? "" : "s"}. Write the headline and the highlights (the lines marked TODO) before merging.`,
    },
  });
  if (!edited.ok) {
    const e = edited.error;
    return err(
      typeof e === "string"
        ? "The wave could not be opened."
        : e.kind === "branch_failed"
          ? `The branch wave/${version} could not be made; a draft of this wave may already be open.`
          : "The wave could not be opened.",
    );
  }
  if (!edited.value.pull) return err("The wave could not be opened.");
  return ok({ version, number: edited.value.pull.number });
}
