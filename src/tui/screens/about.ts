/**
 * `I` — everything a repository *is*, in one card.
 *
 * What it is for, whether it is private, which branch is the default, how to
 * clone it, and — on a mirror — where it came from and when it was last
 * fetched. This is what the repository's home page used to be, and the whole
 * argument for making it a card is that nobody ever went to that page on
 * purpose: they went *through* it, on the way to a file or an issue. So the
 * workspace opens on the work, and the facts are one keystroke away from
 * wherever you already are.
 *
 * The clone URLs are the point of it. They are the single most-copied string
 * on any forge, and the one thing a terminal can hand over without a mouse —
 * `y` puts one on the reader's own clipboard over OSC 52, and every URL on the
 * card is an OSC 8 hyperlink besides.
 */

import { sourcesScreen } from "./sources.ts";
import type { Database } from "bun:sqlite";
import { audienceFor } from "../../core/audience.ts";
import { recentMove } from "../../core/transfer.ts";
import { isPinned } from "../../core/pins.ts";
import { parentReleases, releasesSentence } from "../../core/parent_releases.ts";
import { running } from "../../kernel/version.ts";
import { sshCloneUrl } from "../../ssh/command.ts";
import { checkMemoryAt } from "../../apps/check-memory.ts";
import { repoDir } from "../../git/repos.ts";
import { forkDrift } from "../../actions/forks.ts";
import {
  detachFromParent,
  detachJob,
  detachPhaseWords,
  detachPlanWords,
} from "../../actions/detach.ts";
import { upstreamOffer, type UpstreamOffer } from "../../actions/offer_upstream.ts";
import { listRefs } from "../../git/read.ts";
import { directionNote } from "../../crew/direct.ts";
import { seatsOf } from "../../crew/seats.ts";
import { crewOffInPreview } from "../../crew/preview.ts";
import { addToCrew } from "../../actions/crew.ts";
import { listAgents, listCrewRoles } from "../../core/agents.ts";
import { whyRepo } from "../../flow/why.ts";
import { setCrewOutsiders, updateRepoSettings } from "../../actions/repos.ts";
import { showProvenance } from "../../actions/provenance.ts";
import { appPace } from "../../actions/apps.ts";
import {
  checkLine,
  checkedWords,
  checkUpstreamNow,
  FOLLOW_REFUSALS,
  behindWords,
  followShown,
  setFollowUpstream,
  standing,
  upstreamLabel,
} from "../../actions/upstream_follow.ts";
import { getFollow, listChecks } from "../../core/upstream_follow.ts";
import {
  getProvenance,
  shownTrail,
  sourceLabel,
} from "../../core/provenance.ts";
import {
  canAdmin,
  canWrite,
  forkParentFor,
  getRepoById,
  type Repo,
} from "../../core/repos.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { badge, card } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { PIN_MARK, ago, confirmScreen, drawFacts, later, pickerScreen, plural, promptScreen, yesNo } from "./common.ts";
import { crewScreen } from "./crew.ts";
import { connectionsScreen, egressScreen } from "./egress.ts";
import { eventsScreen } from "./events.ts";
import { newPullScreen } from "./newpull.ts";
import { pullScreen } from "./pull.ts";
import { forkOf, hostOf, liveOrigin, local, localRepo, sourceName } from "./where.ts";

/**
 * `I` — everything a repository is, in one card: what it is for, whether it
 * is private, how to clone it, and where it came from. This is what the repo
 * home page used to be, and it is a card rather than a screen because it is
 * something you glance at on the way to doing something else.
 */
export function aboutScreen(
  f: Session,
  ctx: Ctx,
  parent: Screen,
  src: RepoSource,
  facts: RepoFacts | undefined,
  ref: string,
): Screen {
  // Archiving changes the row under this card, so read it at use.
  let repo = localRepo(src);
  const may = (): boolean =>
    repo !== undefined && f.user !== undefined && canAdmin(f.db, repo, f.user);
  let cell: [string, string][] = [];
  let offered: UpstreamOffer | null = null;
  // The trail's switch (#3293) is a person's, an admin's, and only where
  // there is a trail to switch: the same rule as the settings page.
  const mayTrail = (): boolean =>
    may() &&
    f.user?.kind !== "agent" &&
    repo !== undefined &&
    getProvenance(f.db, repo.id) !== undefined;
  // A person's, an admin's: the settings page's gate.
  const mayPerson = (): boolean => may() && f.user?.kind !== "agent";
  // The following card's rule: an admin's, and only while it is on or to be turned on.
  const mayFollow = (): boolean =>
    may() && repo !== undefined && repo.origin === null;
  // Outsiders is the same person-and-admin gate; `d` (direct) never clashes
  // with `o`, the fork's upstream offer.
  const mayOutsiders = (): boolean => mayPerson();
  // Detach is a person's, an admin's, and only on a fork made here: the
  // Danger zone card's gate (#7452).
  const mayDetach = (): boolean =>
    mayPerson() && repo !== undefined && repo.forkParentId !== null;
  // The team card's button: the first agent not yet on the crew, in the first empty seat.
  const emptySeat = () =>
    repo === undefined ? undefined : seatsOf(f.db, repo, crewOffInPreview()).seats.find((x) => x.by.length === 0);
  // The Maintainers seat: the first agent that declares it and is not yet on the crew.
  const nextMaintainer = () =>
    repo === undefined
      ? undefined
      : (() => {
          const held = new Set(listCrewRoles(f.db, repo.id).filter((c) => c.role === "maintainer").map((c) => c.agent.user.id));
          return listAgents(f.db).find((a) => a.roles.includes("maintainer") && !held.has(a.user.id));
        })();
  const mayMaintain = (): boolean => may() && f.user?.kind !== "agent" && nextMaintainer() !== undefined;
  const mayFill = (): boolean => may() && f.user?.kind !== "agent" && emptySeat() !== undefined;
  const checking = (): boolean =>
    repo !== undefined && followShown(f.app, repo, f.user)?.enabled === true;
  const factRows = (): [string, string][] => [
    ...archivedRow(repo),
    ...movedFromRow(f.db, repo),
    ...movingRow(f, repo),
    ...outsidersRow(repo),
    ...seatRows(f, repo),
    ...maintainerRows(f, repo),
    ...aboutFacts(f, src, facts, ref, repo),
    ...paceRows(f, repo),
    ...trailRows(f, repo),
    ...upstreamRows(f, repo),
    ...offerRows(offered),
    // The phase and git's failure line are the Danger zone card's, an
    // admin's: shown here behind the same gate as `x`.
    ...(mayDetach() ? detachRows(repo) : []),
    ...cell,
  ];
  let rows = factRows();
  // A fork ahead of its parent offers its commits upstream: the page's
  // button, read the same way (`upstreamOffer`), pressed here with `o`.
  const forkParent =
    repo === undefined ? undefined : forkParentFor(f.db, repo, f.user);
  // An archived parent is offered nothing (`upstreamOffer`), so its drift
  // is not read either, as the web home does.
  if (repo !== undefined && forkParent !== undefined && forkParent.archivedAt === null) {
    const at = repo;
    void forkDrift(f.app, at, forkParent)
      .then((drift) => {
        offered = upstreamOffer(f.app, f.user, at, forkParent, drift.ahead);
        if (offered === null) return;
        rows = factRows();
        ctx.invalidate();
      })
      .catch(() => {});
  }
  // An admin also sees the check cell's memory, read once from forge.json.
  if (may() && repo !== undefined) {
    const at = repo;
    void (async () => {
      const refs = await listRefs(repoDir(f.app.reposRoot, at.ownerName, at.name), "refs/heads/");
      const tip = refs.ok
        ? refs.value.find((r) => r.name === `refs/heads/${at.defaultBranch}`)?.oid
        : undefined;
      const words = await checkMemoryAt(repoDir(f.app.reposRoot, at.ownerName, at.name), tip);
      if (words === undefined) return;
      cell = wrap(words ?? "forge.json's check could not be read", 50).map(
        (line, i): [string, string] => [i === 0 ? "check cell" : "", line],
      );
      rows = factRows();
      ctx.invalidate();
    })().catch(() => {
      cell = [["check cell", "forge.json's check could not be read"]];
      try {
        rows = factRows();
        ctx.invalidate();
      } catch {
        // The screen outlived its database (a closing forge): there is nothing left to draw.
      }
    });
  }
  const cloneUrl = rows.find(([label]) => label.startsWith("clone"))?.[1] ?? "";
  const screen: Screen = {
    title: "About",
    get keys() {
      return [
        binding(["y"], "copy URL", { disabled: cloneUrl === "" }),
        ...(repo === undefined
          ? []
          : [binding(["v"], "events"), binding(["C"], "crew")]),
        // A site admin also reaches (early, so a narrow footer keeps them) the repository's private egress grants.
        ...(f.user?.isAdmin === true && repo !== undefined
          ? [binding(["e"], "egress"), binding(["c"], "connections")]
          : []),
        // Only an admin is offered the key, and only an admin's press counts.
        ...(may()
          ? [
              binding(
                ["a"],
                repo?.archivedAt === null ? "archive" : "restore",
              ),
            ]
          : []),
        ...(mayPerson() ? [binding(["w"], "write description")] : []),
        ...(mayPerson() ? [binding(["b"], "default branch")] : []),
        ...(mayOutsiders()
          ? [
              binding(
                ["d"],
                repo?.crewOutsiders === true ? "outsiders off" : "outsiders on",
              ),
            ]
          : []),
        ...(mayTrail()
          ? [
              binding(
                ["t"],
                getProvenance(f.db, repo!.id)?.shown === true
                  ? "hide where this came from"
                  : "show where this came from",
              ),
            ]
          : []),
        ...(mayFollow()
          ? [
              ...(checking() ? [binding(["u"], "check upstream now")] : []),
              binding(["f"], checking() ? "stop following upstream" : "follow upstream"),
            ]
          : []),
        ...(may() && repo?.origin === null ? [binding(["s"], "followed sources")] : []),
        // Who can read it is a person's, an admin's call (#8008).
        ...(mayPerson()
          ? [binding(["V"], repo?.visibility === "public" ? "make private" : "make public")]
          : []),
        ...(mayDetach() && detachJob(repo!.id)?.phase !== "repacking"
          ? [binding(["x"], "detach from parent")]
          : []),
        ...(offered === null
          ? []
          : [
              binding(
                ["o"],
                offered.openNumber === null
                  ? `offer ${plural(offered.ahead, "commit")} upstream`
                  : `see #${offered.openNumber} upstream`,
              ),
            ]),
        ...(mayFill() ? [binding(["p"], `fill ${emptySeat()!.role}`)] : []),
        ...(mayMaintain() ? [binding(["m"], "add maintainer")] : []),
        binding(["esc"], "close"),
      ];
    },
    render(area, s) {
      parent.render(area, s);
      const c = ctx.theme.c;
      const w = Math.min(72, Math.max(30, area.w - 6));
      // The frame, the badges, the description, a blank, and one row per
      // fact — a card with empty rows under its last line reads as a card
      // that lost something.
      const h = Math.min(area.h, rows.length + 5);
      const r = {
        x: area.x + ((area.w - w) >> 1),
        y: area.y + ((area.h - h) >> 1),
        w,
        h,
      };
      const inner = card(s, r, c, {
        title: sourceName(src),
        footer: ref,
        focused: true,
      });
      const lead = inner.x + 1;
      const edge = inner.x + inner.w;
      // The row first: `V` changes it under facts read before the card opened.
      const visibility = repo?.visibility ?? facts?.visibility ?? "public";
      let x = badge(s, inner.x, inner.y, c, {
        text: visibility,
        variant: visibility === "public" ? "success" : "secondary",
      });
      if (repo?.protectDefault === true)
        x = badge(s, x + 1, inner.y, c, { text: "protected", variant: "attn" });
      if (repo !== undefined && repo.forkParentId !== null)
        x = badge(s, x + 1, inner.y, c, { text: "fork", variant: "outline" });
      if (repo !== undefined && repo.origin !== null)
        x = badge(s, x + 1, inner.y, c, { text: "mirror", variant: "attn" });
      if (repo === undefined)
        x = badge(s, x + 1, inner.y, c, {
          text: "read-only",
          variant: "outline",
        });
      if (
        repo !== undefined &&
        f.user !== undefined &&
        isPinned(f.db, f.user.id, repo.id)
      )
        badge(s, x + 1, inner.y, c, {
          text: `${PIN_MARK} on your machine`,
          variant: "outline",
        });
      const description = facts?.description ?? repo?.description ?? "";
      s.text(
        lead,
        inner.y + 1,
        truncate(
          description === "" ? "No description." : description,
          Math.max(0, edge - lead),
        ),
        style(description === "" ? c.faint : c.fg, c.card),
        edge,
      );
      // Who can see it, in the web page's words (#809).
      if (repo !== undefined)
        s.text(
          lead,
          inner.y + 2,
          truncate(
            audienceFor(f.db, repo, f.user).sentence,
            Math.max(0, edge - lead),
          ),
          style(c.mutedFg, c.card),
          edge,
        );
      drawFacts(
        s,
        {
          x: lead,
          y: inner.y + 3,
          w: Math.max(0, edge - lead),
          h: Math.max(0, inner.h - 3),
        },
        c,
        rows,
        c.card,
      );
    },
    key(e) {
      if (e.key === "o" && repo !== undefined && offered !== null && forkParent !== undefined) {
        ctx.pop();
        ctx.push(
          offered.openNumber === null
            ? newPullScreen(f, ctx, repo)
            : pullScreen(f, ctx, local(f, forkParent), offered.openNumber),
        );
        return true;
      }
      if (e.key === "p" && repo !== undefined && mayFill()) {
        const seat = emptySeat()!;
        const onCrew = new Set(listCrewRoles(f.db, repo.id).map((c) => c.agent.user.id));
        const agent = listAgents(f.db).find((a) => !onCrew.has(a.user.id));
        if (agent === undefined) {
          ctx.toast("no agent to put there: make one under Crew first", "danger");
          return true;
        }
        const done = addToCrew(f.app, f.user, repo, agent.user.username, seat.role);
        if (done.ok) {
          rows = factRows();
          ctx.toast(`${agent.user.username} is on ${seat.role}`, "success");
        } else ctx.toast("that could not be changed", "danger");
        ctx.invalidate();
        return true;
      }
      if (e.key === "m" && repo !== undefined && mayMaintain()) {
        const agent = nextMaintainer()!;
        const done = addToCrew(f.app, f.user, repo, agent.user.username, "maintainer");
        if (done.ok) {
          rows = factRows();
          ctx.toast(`${agent.user.username} is a maintainer`, "success");
        } else ctx.toast("that could not be changed", "danger");
        ctx.invalidate();
        return true;
      }
      if (e.key === "d" && repo !== undefined && mayOutsiders()) {
        const at = repo;
        const on = !at.crewOutsiders;
        void setCrewOutsiders(f.app, f.user, at, on, true).then((plan) => {
          if (!plan.ok) return ctx.toast("that could not be changed", "danger");
          ctx.push(
            confirmScreen(ctx, screen, {
              title: "Outsiders",
              body: [
                on
                  ? "Turn on: people who cannot write here may direct the crew."
                  : "Turn off: only people who can write here direct the crew.",
              ],
              actions: [{ label: "Confirm" }, { label: "Cancel" }],
              onChoose: (i) => {
                if (i !== 0) return;
                void setCrewOutsiders(f.app, f.user, at, on, false).then((done) => {
                  if (done.ok) {
                    repo = getRepoById(f.db, at.id) ?? at;
                    rows = factRows();
                    ctx.toast(
                      on
                        ? "outsiders may direct the crew"
                        : "outsiders may not direct the crew",
                      "success",
                    );
                  } else ctx.toast("that could not be changed", "danger");
                  ctx.invalidate();
                });
              },
            }),
          );
        });
        return true;
      }
      if (e.key === "x" && repo !== undefined && mayDetach()) {
        const at = repo;
        void detachFromParent(f.app, f.user, at, true).then((plan) => {
          if (!plan.ok) return ctx.toast("that could not be detached", "danger");
          ctx.push(
            confirmScreen(ctx, screen, {
              title: "Detach from parent",
              body: [detachPlanWords(plan.value)],
              actions: [{ label: "Detach" }, { label: "Cancel" }],
              onChoose: (i) => {
                if (i !== 0) return;
                void detachFromParent(f.app, f.user, at, false).then((started) => {
                  if (!started.ok) {
                    ctx.toast(
                      started.error === "running" ? "a detach is already running" : "that could not be detached",
                      "danger",
                    );
                    return ctx.invalidate();
                  }
                  rows = factRows();
                  ctx.toast("detaching: the repack runs on its own", "default");
                  ctx.invalidate();
                  void detachJob(at.id)?.done.then(() => {
                    repo = getRepoById(f.db, at.id) ?? at;
                    rows = factRows();
                    const failed = detachJob(at.id)?.phase === "failed";
                    ctx.toast(failed ? "the detach stopped" : "detached from its parent", failed ? "danger" : "success");
                    ctx.invalidate();
                  });
                });
              },
            }),
          );
        });
        return true;
      }
      if (e.key === "V" && repo !== undefined && mayPerson()) {
        const at = repo;
        const visibility = at.visibility === "public" ? "private" : "public";
        const name = `${at.ownerName}/${at.name}`;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: visibility === "public" ? "Make public" : "Make private",
            body: wrap(
              visibility === "public"
                ? `Make ${name} public? Anyone with the link can read its code, issues and pulls, signed in or not.`
                : `Make ${name} private? Only its members and the crew can read it from now on; forks and clones already made keep what they have.`,
              52,
            ),
            actions: [
              { label: visibility === "public" ? "Make public" : "Make private" },
              { label: "Cancel" },
            ],
            selected: 1,
            onChoose: (i) => {
              if (i !== 0) return;
              void updateRepoSettings(f.app, f.user, at, { visibility }).then((done) => {
                if (done.ok) {
                  repo = getRepoById(f.db, done.value.id) ?? done.value;
                  rows = factRows();
                  ctx.toast(`now ${visibility}`, "success");
                } else
                  ctx.toast(
                    at.sealedFor !== null
                      ? "a sealed report stays private until it merges"
                      : "that could not be changed",
                    "danger",
                  );
                ctx.invalidate();
              });
            },
          }),
        );
        return true;
      }
      if (e.key === "y" && cloneUrl !== "") {
        ctx.copy(cloneUrl);
        ctx.toast("copied the clone URL", "success");
        return true;
      }
      if (e.key === "a" && repo !== undefined && may()) {
        const waking = repo.archivedAt !== null;
        void updateRepoSettings(f.app, f.user, repo, {
          archived: !waking,
        }).then((done) => {
          if (done.ok) {
            repo = getRepoById(f.db, done.value.id) ?? done.value;
            rows = factRows();
            ctx.toast(waking ? "restored" : "archived", "success");
          } else ctx.toast("that could not be changed", "danger");
          ctx.invalidate();
        });
        return true;
      }
      if (e.key === "w" && repo !== undefined && mayPerson()) {
        const at = repo;
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Description",
            label: "What this repository is for",
            value: at.description,
            hint: "one line; empty clears it",
            onSubmit: (value) => {
              const refusal = descriptionRefusal(value);
              if (refusal !== undefined) {
                ctx.toast(refusal, "danger");
                return refusal;
              }
              void updateRepoSettings(f.app, f.user, at, { description: value }).then((done) => {
                if (done.ok) {
                  repo = getRepoById(f.db, done.value.id) ?? done.value;
                  rows = factRows();
                  ctx.toast("description saved", "success");
                } else ctx.toast("that could not be changed", "danger");
                ctx.invalidate();
              });
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "b" && repo !== undefined && mayPerson()) {
        const at = repo;
        void listRefs(repoDir(f.app.reposRoot, at.ownerName, at.name), "refs/heads/").then((refs) => {
          if (!refs.ok) return ctx.toast("the branches could not be read", "danger");
          const items = refs.value.map((r) => r.name.replace(/^refs\/heads\//, "")).sort().map((name) => ({
            id: name,
            label: name,
            ...(name === at.defaultBranch ? { hint: "default" } : {}),
          }));
          ctx.push(
            pickerScreen(ctx, screen, {
              title: "Default branch",
              items,
              onPick: ([branch]) => {
                if (branch === undefined || branch === at.defaultBranch) return;
                const choose = (choice: number): void => {
                  if (choice !== 0) return;
                  void updateRepoSettings(f.app, f.user, at, { defaultBranch: branch }).then((done) => {
                    if (done.ok) {
                      repo = getRepoById(f.db, done.value.id) ?? done.value;
                      rows = factRows();
                      ctx.toast(`${branch} is the default branch`, "success");
                    } else
                      ctx.toast(
                        done.error === "unknown_branch"
                          ? `${branch} is no longer a branch here`
                          : "that could not be changed",
                        "danger",
                      );
                    ctx.invalidate();
                  });
                };
                void later(ctx, () =>
                  yesNo(
                    ctx,
                    confirmScreen(ctx, screen, {
                      title: "Default branch",
                      body: [`make ${branch} the default? y/n`],
                      actions: [{ label: "Make default" }, { label: "Cancel", variant: "ghost" }],
                      selected: 1,
                      onChoose: choose,
                    }),
                    choose,
                  ),
                );
              },
            }),
          );
        });
        return true;
      }
      if (e.key === "t" && repo !== undefined && mayTrail()) {
        const shown = getProvenance(f.db, repo.id)?.shown === true;
        const done = showProvenance(f.app, f.user, repo, !shown);
        if (done.ok) {
          rows = factRows();
          ctx.toast(done.value.shown ? "where this came from is shown" : "where this came from is hidden", "success");
        } else ctx.toast("that could not be changed", "danger");
        ctx.invalidate();
        return true;
      }
      if (e.key === "u" && repo !== undefined && mayFollow() && checking()) {
        const at = repo;
        ctx.toast("checking the upstream…", "default");
        void checkUpstreamNow(f.app, f.user, at)
          .then((done) => {
            rows = factRows();
            if (done.ok) ctx.toast(checkedWords(done.value), "success");
            else ctx.toast(FOLLOW_REFUSALS[done.error], "danger");
          })
          .catch(() => ctx.toast("that could not be checked", "danger"))
          .finally(() => ctx.invalidate());
        return true;
      }
      if (e.key === "s" && repo !== undefined && may()) {
        ctx.push(sourcesScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "f" && repo !== undefined && mayFollow()) {
        const on = !checking();
        const done = setFollowUpstream(f.app, f.user, repo, {
          url: "",
          branch: "",
          enabled: on,
        });
        if (done.ok)
          ctx.toast(on ? `following ${upstreamLabel(done.value.url)}` : "no longer following the upstream", "success");
        else
          ctx.toast(
            done.error === "invalid_url"
              ? "set the upstream address in the web settings first"
              : FOLLOW_REFUSALS[done.error],
            "danger",
          );
        rows = factRows();
        ctx.invalidate();
        return true;
      }
      if (e.key === "v" && repo !== undefined) {
        ctx.push(eventsScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "C" && repo !== undefined) {
        ctx.push(crewScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "e" && repo !== undefined && f.user?.isAdmin === true) {
        ctx.push(egressScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "c" && f.user?.isAdmin === true) {
        ctx.push(connectionsScreen(f, ctx));
        return true;
      }
      if (e.key === "esc" || e.key === "q" || e.key === "I") {
        ctx.pop();
        return true;
      }
      return true;
    },
  };
  return screen;
}

/**
 * Where a migrated repository came from (#3293), as the web header says it:
 * the source, then each repository up the fork chain — a fork made here of
 * a migrated repository inherits its parent's. Nothing when `shownTrail`
 * has none.
 */
export function trailRows(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  if (repo === undefined) return [];
  const trail = shownTrail(f.db, repo, forkParentFor(f.db, repo, f.user));
  if (trail === undefined) return [];
  return [
    ["migrated from", sourceLabel(trail.sourceUrl)],
    ...trail.parents.map((p): [string, string] => ["fork of", p]),
  ];
}

/**
 * How long an app's golden path took, in the apps page's words (#7488):
 * nothing on a repository that is not an app, or before either figure exists.
 */
export function paceRows(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  if (repo === undefined) return [];
  const pace = appPace(f.app, f.user, repo);
  if (pace === "") return [];
  return wrap(pace, 50).map((line, i): [string, string] => [
    i === 0 ? "golden path" : "",
    line,
  ]);
}

/** The offer row: what the fork has for its parent, and where it stands. */
export function offerRows(offer: UpstreamOffer | null): [string, string][] {
  if (offer === null) return [];
  return [
    [
      "offer",
      offer.openNumber === null
        ? `${plural(offer.ahead, "commit")} ahead · o opens the pull`
        : `${plural(offer.ahead, "commit")} ahead · offered in #${offer.openNumber}`,
    ],
  ];
}

/**
 * The upstream row, as the web About line has it: for an admin only, with
 * the address, branch and last check while following is on, and "off" when
 * it is not.
 */
export function upstreamRows(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  if (repo === undefined || repo.origin !== null) return [];
  if (f.user === undefined || !canAdmin(f.db, repo, f.user)) return [];
  const follow = getFollow(f.db, repo.id);
  if (follow === undefined || !follow.enabled)
    return [["upstream", "off"]];
  const behind = behindWords(follow);
  const checked =
    follow.checkedAt === null ? "" : ` · checked ${ago(follow.checkedAt)}`;
  return [
    [
      "upstream",
      `${upstreamLabel(follow.url)} ${follow.branch}${checked} · ${standing(follow)}`,
    ],
    ...(behind === null ? [] : [["behind", `${behind.text} · u updates`] as [string, string]]),
    ...listChecks(f.db, repo.id).map((c): [string, string] => ["", checkLine(c, ago(c.at))]),
  ];
}

/** Why the repository's builders are held, first gate only (`flow/why.ts`, as MCP `flow`); a writer's. */
export function movingRow(f: Session, repo: Repo | undefined): [string, string][] {
  if (repo === undefined || f.user === undefined || !canWrite(f.app.db, repo, f.user)) return [];
  const { cause } = whyRepo(f.app, repo);
  return [["Moving", cause === null ? "yes" : `no: ${cause.says} ${cause.clears}`]];
}

/** The three seats, in the crew card's words: who fills each, and what an empty one costs. */
export function seatRows(f: Session, repo: Repo | undefined): [string, string][] {
  if (repo === undefined) return [];
  return seatsOf(f.db, repo, crewOffInPreview()).seats.map((x): [string, string] => [
    x.role[0]!.toUpperCase() + x.role.slice(1),
    x.by.length > 0
      ? x.by.join(", ")
      : x.state === "warn"
        ? `empty. No ${x.role}: ${x.without}.`
        : "open seat",
  ]);
}

/** The Maintainers seat: who holds it, or that none does; it holds no pillar, so an empty one costs nothing. */
export function maintainerRows(f: Session, repo: Repo | undefined): [string, string][] {
  if (repo === undefined) return [];
  const names = listCrewRoles(f.db, repo.id).filter((c) => c.role === "maintainer").map((c) => c.agent.user.username);
  return [["Maintainer", names.length > 0 ? names.join(", ") : "open seat"]];
}

/** Who may direct the crew, in `OUTSIDERS_NOTE`'s words; every reader sees it. */
export function outsidersRow(repo: Repo | undefined): [string, string][] {
  if (repo === undefined) return [];
  return wrap(directionNote(repo), 50).map((line, i): [string, string] => [
    i === 0 ? "Crew" : "",
    line,
  ]);
}

/** Where a detach from the parent stands (#7452): the Danger zone card's line. */
export function detachRows(repo: Repo | undefined): [string, string][] {
  if (repo === undefined) return [];
  const words = detachPhaseWords(detachJob(repo.id), ago);
  return words === null ? [] : [["detach", words]];
}

/** The longest description the MCP `repo_settings` tool takes; Settings has no cap of its own. */
const DESCRIPTION_MAX = 2000;

/** Why a typed description is refused, in words, or nothing when it stands. */
function descriptionRefusal(value: string): string | undefined {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return "a description is one line of plain text";
  if ([...value].length > DESCRIPTION_MAX) return `a description is ${DESCRIPTION_MAX} characters at most`;
  return undefined;
}

/** "Moved from <old path> on <date>" for 30 days after a move: the web page's line, from the same function. */
export function movedFromRow(db: Database, repo: Repo | undefined, now: number = Date.now()): [string, string][] {
  const move = repo === undefined ? undefined : recentMove(db, repo.id, now);
  return move === undefined ? [] : [["moved from", `${move.from} on ${move.at.slice(0, 10)}`]];
}

/** One line when an admin has put the repository away. */
function archivedRow(repo: Repo | undefined): [string, string][] {
  if (repo === undefined || repo.archivedAt === null) return [];
  return [["archived", repo.archivedAt.slice(0, 10)]];
}

/**
 * The web following card's releases sentence, for a fork on a forge that
 * names a parent forge: the same words, from the same cache.
 */
export function releasesRow(
  f: Session,
  repo: Repo | undefined,
): [string, string][] {
  const { parentUrl, dataDir, parentLoopback } = f.app.config;
  if (repo === undefined || repo.forkParentId === null) return [];
  if (parentUrl === undefined) return [];
  const view = parentReleases(dataDir, parentUrl, {
    loopback: parentLoopback === true,
  });
  return [
    [
      "releases",
      releasesSentence(view, running().version, new URL(parentUrl).host),
    ],
  ];
}

/**
 * The label/value block. A repository we hold gets the clone URLs (the single
 * most-copied string on any forge, and the one thing a terminal can hand over
 * without a mouse); a live browse gets the page it is reading instead.
 */
function aboutFacts(
  f: Session,
  src: RepoSource,
  facts: RepoFacts | undefined,
  ref: string,
  current?: Repo,
): [string, string][] {
  const repo = localRepo(src);
  const counts: [string, string][] =
    facts === undefined ||
    ((facts.openIssues ?? 0) === 0 && (facts.openPulls ?? 0) === 0)
      ? []
      : [
          [
            "open",
            [
              facts.openIssues === null
                ? ""
                : plural(facts.openIssues, "issue"),
              facts.openPulls === null ? "" : plural(facts.openPulls, "pull"),
            ]
              .filter((p) => p !== "")
              .join(" · "),
          ],
        ];
  // The card's own row first: `b` moves it under facts read before the card opened.
  const branch = current?.defaultBranch ?? facts?.defaultBranch ?? repo?.defaultBranch ?? "";
  // Whose work this descends from. A fork at an origin is not `forkParentId`
  // — that is a fork made *here* — so the badge above cannot say it and this
  // row can.
  const upstream = forkOf(f, src);
  const fork: [string, string][] =
    upstream === "" ? [] : [["fork of", upstream]];
  const releases = releasesRow(f, repo);
  // "browsing" only when it is not the obvious answer: a row that repeats
  // the line above it is a row nobody reads.
  const browsing: [string, string][] =
    ref === "" || ref === branch ? [] : [["browsing", ref]];
  if (repo !== undefined)
    return [
      ["default branch", branch],
      ...browsing,
      ...counts,
      ...fork,
      ...releases,
      ...originFacts(repo),
      ...cloneFacts(f, repo),
    ];
  const live = liveOrigin(src);
  const out: [string, string][] = [];
  if (live !== undefined)
    out.push([
      "reading",
      `${hostOf(live.origin.webUrl)} · ${live.origin.login}'s connection`,
    ]);
  if (facts !== undefined) {
    out.push(["default branch", facts.defaultBranch]);
    if (facts.pushedAt !== null) out.push(["last push", ago(facts.pushedAt)]);
  }
  out.push(...browsing);
  out.push(...counts);
  out.push(...fork);
  if (live !== undefined) out.push(["page", live.htmlUrl]);
  return out;
}

/** Where a mirror came from and when it was last fetched — one line. */
function originFacts(repo: Repo): [string, string][] {
  const origin = repo.origin;
  if (origin === null) return [];
  const host = hostOf(origin.htmlUrl);
  const fetched =
    origin.lastFetchAt === null
      ? "never fetched"
      : `fetched ${ago(origin.lastFetchAt)}`;
  const error = origin.fetchError === "" ? "" : ` · ${origin.fetchError}`;
  return [
    [
      "mirrored from",
      `${origin.fullName}${host === "" ? "" : ` @ ${host}`} · ${fetched}${error}`,
    ],
  ];
}

/**
 * The two clone URLs: HTTP from the forge's public address, the same one
 * the web page shows, and SSH from the one builder (absent when SSH is off).
 */
export function cloneFacts(f: Session, repo: Repo): [string, string][] {
  const config = f.app.config;
  const origin =
    config.url !== undefined
      ? new URL(config.url).origin
      : `http://${config.host ?? "localhost"}:${config.port ?? 3000}`;
  const out: [string, string][] = [
    ["clone (http)", `${origin}/${repo.ownerName}/${repo.name}.git`],
  ];
  const ssh = sshCloneUrl(f.app, repo.ownerName, repo.name);
  if (ssh !== undefined) out.push(["clone (ssh)", ssh]);
  return out;
}

