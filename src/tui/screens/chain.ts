/**
 * The chain of forges this forge's code descends from, in a card. The gate is
 * the page's: only someone who can read `<org>/forge` sees it, and only that
 * repository's owner is offered Sever, which asks for the same typed word,
 * `m`, which flips the follow mode, and `t`, which takes the new commits as a pull.
 */

import type { App as Forge } from "../../app.ts";
import { FOLLOW_MODE_REFUSALS, followModeSaid, setFollowMode, severForge, takeForgeCode, takeForgeWords } from "../../actions/follow.ts";
import { SEVER_CONFIRM } from "../../actions/sever_invite_words.ts";
import { forgeProposalLine, forgeProposals, proposeToParentForge } from "../../actions/upstream.ts";
import { checkUpstream, upstreamState, upstreamWords } from "../../spawn/upstream.ts";
import { parentCredential } from "../../spawn/parent_credential.ts";
import { canAdmin, canRead, canWrite, getRepo, type Repo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { chainLines, chainOfRepo, forgeLinkOf, type ChainView, type FollowMode } from "../../spawn/chain.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { card } from "../ui/widgets.ts";
import { drawFacts, promptScreen } from "./common.ts";
import { familyScreen } from "./family.ts";

/** The forge repository and its chain, when this viewer may read that repository. */
export async function readableChain(
  app: Forge,
  user: User | undefined,
): Promise<{ repo: Repo; view: ChainView } | undefined> {
  const link = await forgeLinkOf(app);
  if (link === undefined) return undefined;
  const [owner, name] = link.repo.split("/") as [string, string];
  const repo = getRepo(app.db, owner, name);
  if (!repo || !canRead(app.db, repo, user)) return undefined;
  const view = await chainOfRepo(app, repo);
  return view === undefined ? undefined : { repo, view };
}

export async function chainScreen(app: Forge, user: User | undefined, ctx: Ctx): Promise<Screen> {
  const found = await readableChain(app, user);
  if (found === undefined) return familyScreen(ctx, [["chain", "this forge follows nothing across forges"]], "Chain");
  const { repo, view } = found;
  const owner = user !== undefined && view.severedAt === null && canAdmin(app.db, repo, user);
  const writer = user !== undefined && view.severedAt === null && canWrite(app.db, repo, user);
  const proposing = view.severedAt === null && (await parentCredential(app)) !== undefined;
  const linesOf = async (): Promise<[string, string][]> => [
    ...chainLines((await chainOfRepo(app, repo)) ?? view),
    ...(view.lines.find((l) => l.here)?.mode != null ? [["upstream", upstreamWords(await upstreamState(app))] as [string, string]] : []),
    ...(proposing
      ? (await forgeProposals(app, repo, Date.now(), user !== undefined)).map(
          (p): [string, string] => ["proposal", forgeProposalLine(p)],
        )
      : []),
  ];
  let rows = await linesOf();
  // The page's condition: the owner, not severed, and the parent has something.
  let behind = owner ? ((await upstreamState(app))?.behind ?? 0) : 0;
  if (!owner && !writer) return familyScreen(ctx, rows, "Chain");
  const self: Screen = {
    title: "Chain",
    keys: [
      ...(writer ? [binding(["c"], "check now")] : []),
      ...(writer && proposing ? [binding(["p"], "propose")] : []),
      ...(behind > 0 ? [binding(["t"], `take ${behind} new commit${behind === 1 ? "" : "s"}`)] : []),
      ...(owner ? [binding(["m"], "follow mode"), binding(["s"], "sever")] : []),
      binding(["esc"], "close"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.min(78, Math.max(30, area.w - 6));
      const h = Math.min(area.h, rows.length + 2);
      const r = { x: area.x + ((area.w - w) >> 1), y: area.y + ((area.h - h) >> 1), w, h };
      const inner = card(s, r, c, { title: "Chain", focused: true });
      drawFacts(s, { x: inner.x + 1, y: inner.y, w: Math.max(0, inner.w - 1), h: inner.h }, c, rows, c.card);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "c" && writer)
        void checkUpstream(app).then(async (state) => {
          if (state === undefined) return ctx.toast("This forge follows nothing", "danger");
          rows = await linesOf();
          ctx.toast(upstreamWords(state), state.error === "" ? "success" : "danger");
        });
      else if (e.key === "p" && writer && proposing)
        void proposeToParentForge(app, user, repo).then(async (made) => {
          if (!made.ok) {
            const err = made.error;
            return ctx.toast(
              err === "nothing_to_propose"
                ? "Nothing here is ahead of the parent forge"
                : typeof err === "string"
                  ? `Not proposed: ${err}`
                  : err.kind === "unreachable"
                    ? "Parent unreachable: nothing was proposed"
                    : `The parent forge did not take it: ${err.reason}`,
              "danger",
            );
          }
          rows = await linesOf();
          ctx.toast(`Proposed to the parent forge as #${made.value.number}`, "success");
        });
      else if (e.key === "t" && owner && behind > 0)
        void takeForgeCode(app, user, repo).then(async (took) => {
          if (!took.ok) return ctx.toast(`Not taken: ${took.error}`, "danger");
          const said = takeForgeWords(took.value);
          rows = await linesOf();
          ctx.toast(said.message, said.tone ?? "success");
        });
      else if (e.key === "m" && owner)
        void forgeLinkOf(app).then(async (link) => {
          const next: FollowMode = link?.mode === "take-updates" ? "tell-me" : "take-updates";
          const set = await setFollowMode(app, user, repo, next);
          if (!set.ok) return ctx.toast(FOLLOW_MODE_REFUSALS[set.error].message, "danger");
          rows = await linesOf();
          ctx.toast(followModeSaid(undefined, set.value), "success");
        });
      else if (e.key === "s" && owner)
        ctx.push(
          promptScreen(ctx, self, {
            title: "Sever from the parent forge",
            label: "type sever to confirm",
            onSubmit: (word) => {
              if (word.trim() !== "sever") return SEVER_CONFIRM;
              return severForge(app, user, repo).then((cut) => {
                if (!cut.ok) return ctx.toast(`Not severed: ${cut.error}`, "danger");
                ctx.pop();
                ctx.toast("Severed: this forge follows nothing now", "success");
              });
            },
          }),
        );
      return true;
    },
  };
  return self;
}
