/**
 * Contributing to somebody else's repository, as one workflow.
 *
 * The owner's sentence for it is "grab my repo, clone, branch, edit, PR", and
 * `actions/contribute.ts` is already that in one call. This file is the
 * terminal's half: the two questions a person has to answer (do you want a
 * fork? what are you proposing?) and nothing else. Everything that could
 * leave a half-finished state — a fork with no copy, a branch with no commit,
 * a commit nobody proposed — is the action's problem, not a screen's.
 *
 * Two entry points, one idea.
 *
 * - **`F` — fork at the origin.** A confirm card, then `forkOrigin`, then the
 *   ordinary mirror card over the job it started, then the fork's own
 *   workspace. The card says the whole sentence ("fork X to your account at
 *   Y and mirror it here?") because forking touches two machines and a person
 *   should be told which.
 * - **`c` — propose a change.** On a repository the origin says you cannot
 *   push to, the commit dialog is a *proposal* dialog: same buffers, same
 *   ticked files, one extra field (the branch it lands on in your fork) and
 *   a pull opened upstream. `contribute` decides fork-or-direct from the
 *   origin's own answer; this only decides what to render.
 *
 * The read-only rule the workspace has always kept is unchanged: nothing here
 * writes a byte locally. A live browse still cannot commit *here* — what it
 * can do is send the change to the origin, which is a different thing.
 */

import { contribute, forkOrigin } from "../../actions/contribute.ts";
import type {
  ContributeError,
  ContributeResult,
} from "../../actions/contribute.ts";
import type { EditFile } from "../../actions/contents.ts";
import { getRepoById, type Repo } from "../../core/repos.ts";
import type { Result } from "../../kernel/result.ts";
import type { RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { confirmScreen, errorText, runAsync } from "./common.ts";
import { editErrorText } from "./commit.ts";
import { showMirrorJob } from "./mirror.ts";
import { hostLabel, hostOf, liveOrigin, localRepo } from "./where.ts";

/** A repository at an origin, as this screen has to name it. */
export interface OriginTarget {
  readonly originId: string;
  /** `owner/name` at the origin. */
  readonly fullName: string;
  /** `codeberg.org` — what the confirm card says out loud. */
  readonly host: string;
}

/**
 * The repository at an origin this source stands for, whichever side it was
 * opened from: the remote a live browse is reading, or the remote a mirror
 * mirrors. Undefined for a native repository, which has no origin and takes
 * the local fork instead.
 */
export function originTarget(src: RepoSource): OriginTarget | undefined {
  const live = liveOrigin(src);
  if (live !== undefined)
    return {
      originId: live.origin.id,
      fullName: live.fullName,
      host: hostOf(live.origin.webUrl),
    };
  const repo = localRepo(src);
  const link = repo?.origin;
  if (link === undefined || link === null) return undefined;
  return {
    originId: link.originId,
    fullName: link.fullName,
    host: hostLabel(link.htmlUrl, link.fullName),
  };
}

export interface ForkAtOriginOptions {
  /** Drawn behind the confirm card and the mirror card. */
  readonly parent: Screen;
  readonly target: OriginTarget;
  /** Where to go once there is a local copy of the fork. */
  readonly onForked: (fork: Repo) => void;
}

/**
 * `F` at an origin: ask, fork, copy, arrive.
 *
 * The mirror is asked for as a *job* rather than awaited, because a fork is
 * a clone plus every issue and it belongs behind the same progress card every
 * other mirror uses. A fork that already existed and is already mirrored
 * skips both cards — there is nothing to watch and nothing to confirm.
 */
export function forkAtOrigin(
  f: Session,
  ctx: Ctx,
  o: ForkAtOriginOptions,
): void {
  const { originId, fullName, host } = o.target;
  ctx.push(
    confirmScreen(ctx, o.parent, {
      title: "Fork at the origin",
      // Two lines because the card is 54 columns wide and this sentence
      // names a repository *and* a host: truncating either half is exactly
      // the information somebody presses this key to confirm.
      body: [
        `Fork ${fullName} to your account`,
        `at ${host} and mirror it here?`,
        "",
        "The copy here is your workbench.",
      ],
      actions: [{ label: "Cancel", variant: "ghost" }, { label: "Fork" }],
      selected: 1,
      onChoose: (choice) => {
        if (choice !== 1) return;
        runAsync(ctx, async () => {
          const forked = await forkOrigin(f.app, f.user, originId, fullName, {
            mirror: "job",
          });
          if (!forked.ok) {
            ctx.toast(errorText(forked.error), "danger");
            return;
          }
          const { remote, mirror, job, existed } = forked.value;
          if (mirror !== undefined) {
            ctx.toast(
              existed
                ? `you already have ${remote.fullName}`
                : `forked as ${remote.fullName}`,
              "success",
            );
            o.onForked(mirror);
            return;
          }
          if (job === undefined) {
            ctx.toast(`forked as ${remote.fullName}`, "success");
            return;
          }
          showMirrorJob(f, ctx, job, {
            parent: o.parent,
            originId,
            fullName: remote.fullName,
            onDone: o.onForked,
          });
        });
      },
    }),
  );
}

// ---- proposing a change ----

/**
 * Where a change made in this workspace has to go, when it cannot go here.
 *
 * `permissions.push` is the whole question, and only the *source* can answer
 * it: locally it is `canWrite`, live it is whatever the origin reports. So a
 * live browse of a repository you cannot push to proposes, and so does a
 * mirror of one — the mirror is ours, but the branch is not ours to move
 * (`docs/ORIGINS.md`: the origin is truth for a mirror).
 *
 * Undefined means the ordinary commit dialog: a native repository, a
 * repository the origin says you may push to, or a source that has not
 * answered yet. It is a hint for what to render — the protection is
 * `contribute`'s, which asks the origin itself.
 */
export function proposeTarget(
  src: RepoSource,
  canPushUpstream: boolean | undefined,
): OriginTarget | undefined {
  if (canPushUpstream !== false) return undefined;
  return originTarget(src);
}

/** The one-line status a workspace wears while it is proposing. */
export const proposingStatus = (target: OriginTarget): string =>
  `proposing to ${target.fullName} via your fork`;

export interface ProposeInput {
  readonly target: OriginTarget;
  /** The upstream branch the work starts from and targets. */
  readonly base: string;
  readonly branch: string;
  readonly message: string;
  readonly files: readonly EditFile[];
  readonly pull: { title: string; body?: string };
}

/** Send the whole change through `contribute` — fork, branch, commit, pull. */
export function propose(
  f: Session,
  input: ProposeInput,
): Promise<Result<ContributeResult, ContributeError>> {
  return contribute(f.app, f.user, {
    originId: input.target.originId,
    fullName: input.target.fullName,
    branch: input.branch,
    base: input.base,
    message: input.message,
    files: input.files,
    openPull: {
      title: input.pull.title,
      ...(input.pull.body === undefined || input.pull.body === ""
        ? {}
        : { body: input.pull.body }),
    },
  });
}

/**
 * `contribute` refuses with a union of bare codes and two tagged objects, and
 * the tagged ones are the interesting half: one says the commit never landed,
 * the other says it landed and only the proposal did not. A dialog that
 * flattened them to "that failed" would be asking somebody to guess whether
 * their work still exists.
 */
export function contributeErrorText(error: ContributeError): string {
  if (typeof error === "string") return errorText(error);
  if (error.kind === "edit_failed") return editErrorText(error.reason);
  return `the commit landed (${error.commit.commitOid.slice(0, 8)}), but the pull did not open: ${errorText(error.reason)}`;
}

/** The local mirror the opened pull was imported into, when there is one. */
export function importedInto(
  f: Session,
  result: ContributeResult,
): { repo: Repo; number: number } | undefined {
  const local = result.pull?.local;
  if (local === undefined) return undefined;
  const repo = getRepoById(f.db, local.repoId);
  return repo === undefined ? undefined : { repo, number: local.number };
}
