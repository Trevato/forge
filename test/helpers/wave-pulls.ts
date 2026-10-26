/** A merged pull on a real branch, and a wave file naming pulls by local link — for the doors to a wave. */
import { openPull } from "../../src/actions/pulls.ts";
import { commitToBranch } from "../../src/actions/repos.ts";
import type { App } from "../../src/app.ts";
import type { Repo } from "../../src/core/repos.ts";
import type { User } from "../../src/core/users.ts";
import { writeWave } from "../../src/story/wave.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** Opens a pull titled `title` from a new branch, marks it merged, returns its number. */
export async function mergedPull(app: App, owner: User, repo: Repo, title: string): Promise<number> {
  const branch = `t-${title.replace(/\W/g, "")}`;
  must(
    await commitToBranch(app, owner, repo, {
      branch,
      message: title,
      files: [{ path: `${branch}.txt`, content: "x" }],
    }),
  );
  const p = must(
    await openPull(app, owner, repo, { title, body: "", baseBranch: "main", headBranch: branch }),
  );
  app.db
    .query("UPDATE pull SET merged_at = '2026-03-04T10:00:00.000Z' WHERE issue_id = ?")
    .run(p.id);
  return p.number;
}

/** The text of a wave file whose pulls are the given `owner/name#number` links. */
export function waveNaming(version: string, refs: { owner: string; name: string; number: number }[]): string {
  const w = writeWave({
    version,
    date: "2026-03-05",
    headline: "Mixed",
    highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
    pulls: refs.map((r) => ({
      title: `#${r.number} as written`,
      url: `https://forge.example/${r.owner}/${r.name}/pulls/${r.number}`,
    })),
  });
  if (!w.ok) throw w.error;
  return w.value;
}
