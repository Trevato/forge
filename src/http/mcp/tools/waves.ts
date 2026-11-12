import { pullRefs, readWave, readWaves } from "../../../story/waves.ts";
import { VERSION as WAVE_VERSION } from "../../../story/wave.ts";
import { repoDir } from "../../../git/repos.ts";
import { movedForViewer, waveProgress } from "../../../story/wave_moved.ts";
import { planNow } from "../../../story/wave_plan.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "waves",
  doc: "`{ repo, version? }`: the repository's waves newest first (version, date, headline; a broken file is `{ version, error }`), or with `version` one wave: headline, progress, highlights with their why, pull numbers (with the `ui://forge/wave` card); a private repository is not found to a stranger",
  description: "Waves; `version`: one.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      version: { type: "string", maxLength: 64 },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
    const version = args["version"];
    if (version === undefined) {
      const entries = await readWaves(dir, repo.defaultBranch);
      return good({
        repo: repo.ownerName + "/" + repo.name,
        waves: entries.map((e) =>
          e.ok ? { version: e.wave.version, date: e.wave.date, headline: e.wave.headline } : { version: e.file.replace(/\.md$/, ""), error: e.reason },
        ),
      });
    }
    if (typeof version !== "string" || !WAVE_VERSION.test(version))
      return bad("invalid", "`version` is a wave's version, such as 0.7.81");
    const entry = await readWave(dir, repo.defaultBranch, version);
    if (entry === null) return bad("not_found", `no wave ${version}`);
    if (!entry.ok) return bad("invalid", entry.reason);
    const w = entry.wave;
    const progress = waveProgress(
      movedForViewer({ db: ctx.app.db, repo, refs: pullRefs(w), viewer: user, plan: () => planNow(ctx.app.db, repo, new Date()) }),
    );
    return good({
      repo: repo.ownerName + "/" + repo.name,
      wave: {
        version: w.version,
        date: w.date,
        headline: w.headline,
        ...(progress === "" ? {} : { progress }),
        highlights: w.highlights,
        pulls: w.pulls.flatMap((p) => {
          const n = /\/pulls\/(\d+)\/?$/.exec(p.url);
          return n ? [Number(n[1])] : [];
        }),
      },
    });
  },
};
