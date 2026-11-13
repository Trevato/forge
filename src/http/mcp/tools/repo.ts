import { provenanceFacts } from "../../../core/provenance.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { audienceFor } from "../../../core/audience.ts";
import { upstreamFacts } from "../../../actions/upstream_follow.ts";
import { creditFacts } from "../../../actions/credit_facts.ts";
import { CHAPTER_WORDS, type ChapterActError, close, fill, open, preview } from "../../../actions/chapters.ts";
import { getChapter, itemsOf, listChapters, progressOf, progressSentence } from "../../../core/chapters.ts";
import { err } from "../../../kernel/result.ts";
import { good, str, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "repo",
  doc: "`{ repo }`: one repository's description, visibility, autonomy, `audience { level, who, sentence }` and `provenance` (where a migrated one came from, `null` when hidden), `credit` (a mirror's upstream, licence, authors; `null` otherwise), the same as `GET /api/v1/repos/:owner/:name`; `action` (`open|add|remove|close` with `chapter`, `number` for add/remove; a person who administers it, `rw` token) says what it would do, and with `confirm: true` does it, as the page; `view: \"chapters\"` lists its chapters with state, and with `chapter` names one's items (`done|building|left`) and `progress` (the page's sentence)",
  description:
    "One repository you can read, as GET /api/v1/repos/:owner/:name.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, view: { type: "string", enum: ["chapters"] }, chapter: { type: "string" }, action: { type: "string", enum: ["open", "add", "remove", "close"] }, number: { type: "integer" }, confirm: { type: "boolean" } },
    required: ["repo"],
  },
  writes: true,
  /** Without a confirmed `action` it only reads or previews. */
  readsWhen: (args) => args["action"] === undefined || args["confirm"] !== true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["action"] !== undefined) {
      const verb = args["action"];
      if (verb !== "open" && verb !== "add" && verb !== "remove" && verb !== "close") return bad("invalid", "`action` is open, add, remove or close");
      const name = str(args["chapter"]);
      if (name === "") return bad("invalid", "`action` needs `chapter`");
      const number = args["number"];
      if ((verb === "add" || verb === "remove") && (typeof number !== "number" || !Number.isInteger(number) || number < 1))
        return bad("invalid", "`add` and `remove` need an issue `number`");
      const n = typeof number === "number" ? number : undefined;
      const refused = (e: keyof typeof CHAPTER_WORDS) => bad(e, CHAPTER_WORDS[e]);
      if (args["confirm"] !== true) {
        const seen = await preview(ctx.app, user, repo, verb, name, n);
        return seen.ok ? good({ ...seen.value, done: false, says: `${seen.value.says} Send confirm: true to do it.` }) : refused(seen.error);
      }
      const done = verb === "close" ? await close(ctx.app, user, repo, name, true)
        : verb === "open" ? open(ctx.app, user, repo, name)
        : n === undefined ? err<ChapterActError>("not_found")
        : fill(ctx.app, user, repo, name, n, verb === "add");
      return done.ok ? good({ done: true, chapter: name, action: verb, ...(n === undefined ? {} : { number: n }) }) : refused(done.error);
    }
    if (args["view"] === undefined && args["chapter"] !== undefined) return bad("invalid", "`chapter` needs `view: chapters`");
    if (args["view"] !== undefined) {
      if (args["view"] !== "chapters") return bad("invalid", "`view` is \"chapters\"");
      const now = new Date();
      const name = str(args["chapter"]);
      if (name === "")
        return good({ chapters: listChapters(ctx.app.db, repo.id).map((c) => ({ name: c.name, means: c.means, state: c.state })) });
      const c = getChapter(ctx.app.db, repo.id, name);
      if (c === undefined) return bad("not_found", "no such chapter");
      const items = itemsOf(ctx.app.db, c);
      const p = progressOf(c, items, now);
      return good({
        name: c.name, means: c.means, state: c.state, progress: progressSentence(p), finishesOn: p.finishesOn,
        items: items.map((i) => ({ number: i.number, title: i.title, status: i.status, doneAt: i.doneAt })),
      });
    }
    return good({
      repo: `${repo.ownerName}/${repo.name}`,
      description: repo.description,
      visibility: repo.visibility,
      autonomy: repo.autonomy,
      audience: audienceFor(ctx.app.db, repo, user),
      provenance: provenanceFacts(
        ctx.app.db,
        repo,
        forkParentFor(ctx.app.db, repo, user),
      ),
      upstream: upstreamFacts(ctx.app.db, repo, user),
      credit: await creditFacts(ctx.app, repo, user),
    });
  },
};
