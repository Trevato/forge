/**
 * Repository pages: the code at a ref, one file, and the raw bytes.
 * Everything is URL-addressable and renders without JavaScript; reads go
 * straight to git, so nothing shown here is stored anywhere else.
 *
 * Every ref reaching git passes `isSafeRef` first, and every ref *leaving*
 * here in a URL is percent-encoded, so a branch called `feature/a` stays one
 * path segment and can never smuggle a path of its own.
 */

import { repoLine } from "../describe.ts";
import { recordLook } from "../../flow/valve_store.ts";
import { PINNED_PUBLIC, immutableWhenAddressed, mayShare } from "../../http/addressed.ts";
import { EDGE_VARY } from "../../http/edge_cache.ts";
import { keepPage, keptPage, keptPageKey } from "./kept_page.ts";
import { cachedBlobPage, cachedRaw, cachedTree, keepBlobPage, keepRaw, keepTree, keptRefs, resolveCommit, withKeptFolders } from "./tree_cache.ts";
import { behindLine, followingLine, originAheadLine } from "./upstream-follow.ts";
import { CONFLICT_WORDS, UNREAD_WORDS } from "../../origins/ahead.ts";
import { upstreamOffer } from "../../actions/offer_upstream.ts";
import { offerUpstream } from "./offer-upstream.ts";
import { VERIFY_FIRST } from "../../actions/verify_words.ts";
import { GUEST_REFUSALS, HELP_BUILD, HELP_BUILD_NEXT, isContributionFork, isGuestRefusal } from "../../core/contribute.ts";
import { lacks, NOT_A_MEMBER } from "../../core/roles.ts";
import { storageLimitMessage } from "../../core/storage.ts";
import { canRead, canWrite, listForks, type Repo } from "../../core/repos.ts";
import { FORKS_PER_DAY, forkRepo, repositoryLimitMessage } from "../../actions/repos.ts";
import {
  type RankedFork,
  forkDrift,
  driftWords,
  nothingNewHeading,
  rankedForksOf,
  MAX_RANKED_FORKS,
  type ForkRanking,
  takeUpdates,
  type ForkDrift,
} from "../../actions/forks.ts";
import { lineageOf } from "../../core/following.ts";
import {
  archivedParentLine,
  followingCard,
  followingOf,
  lineageCard,
} from "./following.ts";
import { nothingNew } from "../../actions/follow.ts";
import { frozenBlock } from "./frozen.ts";
import { pinRepo, syncRepoNow, takeFromOrigin, unpinRepo } from "../../actions/origins.ts";
import {
  canAdmin,
  forkParentFor,
  forkTree,
  type ForkNode,
  visibleForks,
} from "../../core/repos.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { blobForRender, type TreeEntry } from "../../git/read.ts";
import { repoDir } from "../../git/repos.ts";
import { estimateTokens } from "../../kernel/tokens-format.ts";
import { safeBack, type Ctx } from "../../http/context.ts";
import { holds } from "../../http/etag.ts";
import { json, notFound } from "../../http/respond.ts";
import type { Blob, RepoSource } from "../../view/source.ts";
import {
  crumbsFor,
  loadRepo,
  notFoundPage,
  repoBase,
  repoHeader,
  scopeHeader,
  signInFirst,
} from "../chrome.ts";
import { codeJs } from "../client.ts";
import { countLines, highlightPrefix } from "../code.ts";
import { latestWave } from "../../story/waves.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { liveClientJs, liveMount } from "../live.ts";
import { appStrip } from "./apps.ts";
import { studioApp } from "../studio/app.ts";
import { declaresFeature } from "../../actions/features.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { field, readForm } from "../form.ts";
import { html, raw, when, type Html } from "../html.ts";
import { creditLine } from "../credit_line.ts";
import { type CodeRows, rowsMarkup } from "../code_rows.ts";
import { rowsOffThread } from "../code_rows_pool.ts";
import { flashTo, fragment, page, redirect } from "../layout.ts";
import { renderMarkdown } from "../markdown.ts";
import { overSize } from "../render/archive.ts";
import { csvJs, isCsvPath } from "../render/csv.ts";
import { fontJs } from "../render/font.ts";
import { hasTable } from "../render/sqlite.ts";
import { fileKind, HEAD_BYTES, kindByName, RENDER_CAP } from "../render/kinds.ts";
import { RENDERERS, rendererFor } from "../render/renderers.ts";
import { downloadHref, mediaHref } from "./media.ts";
import { browseBase, localScope, type RepoScope } from "../scope.ts";
import { repoForkOf } from "../../core/origins.ts";
import { recentMove } from "../../core/transfer.ts";
import {
  badge,
  btn,
  card,
  empty,
  fileSize,
  sizeWithTokens,
  tokenCount,
  icon,
  listCard,
  type CardOptions,
  row,
  seg,
  time,
  copyField,
} from "../ui.ts";

const MAX_RENDER_BYTES = 1_000_000;
// A blob under the byte cap can still be pathological (a megabyte of newlines
// is ~490k lines). Bounding rendered lines bounds the response independently.
/** Lines a file page draws before it links the rest (`?all=1` draws every one). */
const FIRST_LINES = 1_500;
const MAX_RENDER_LINES = 10_000;

import { sshCloneUrl } from "../../ssh/command.ts";
import { pathCrumbs, refMenu, refSetFrom, type RefSet } from "./refs.ts";
import {
  codeLayout,
  codeMount,
  explorerColumn,
  explorerFragment,
  finderButton,
  finderDialog,
  loadExplorer,
  treeWindow,
} from "./explorer.ts";

export { crumbsFor, loadRepo, repoBase };
export { pathCrumbs, refMenu, refSet, refSetFrom } from "./refs.ts";

// ---- fork ----

/** The parent and the forks this viewer may see, from the request. */
const forkParent = (ctx: Ctx, repo: Repo): Repo | undefined =>
  forkParentFor(ctx.app.db, repo, ctx.auth.user);
const forksFor = (ctx: Ctx, repo: Repo): Repo[] =>
  visibleForks(ctx.app.db, repo.id, ctx.auth.user);

/**
 * GET /:owner/:name/forks — every fork of this repository the viewer may
 * see, newest first. The count on the repository page is the way in.
 */
export async function forksPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  let t = performance.now();
  const repo = loadRepo(ctx);
  notePhase(ctx.request, "repository", performance.now() - t);
  if (!repo) return notFoundPage(ctx);
  t = performance.now();
  const forks = listForks(ctx.app.db, repo.id).filter((fork) =>
    canRead(ctx.app.db, fork, ctx.auth.user),
  );
  notePhase(ctx.request, "forks", performance.now() - t);
  t = performance.now();
  const tree = forkTree(ctx.app.db, repo.id, ctx.auth.user);
  notePhase(ctx.request, "fork-tree", performance.now() - t);
  t = performance.now();
  // The whole family, from the oldest ancestor this viewer may see: who
  // follows whom, and where each stands against the one it follows.
  const lineage = await lineageOf(ctx.app, repo, (r) =>
    canRead(ctx.app.db, r, ctx.auth.user),
  );
  notePhase(ctx.request, "lineage", performance.now() - t);
  t = performance.now();
  const ranked = await rankedForksOf(ctx.app, repo, forks);
  notePhase(ctx.request, "drift", performance.now() - t);
  t = performance.now();
  const body = html`${repoHeader(ctx, repo, "forks")}
    <div class="page-head mt">
      <h2>${forks.length} fork${forks.length === 1 ? "" : "s"}</h2>
    </div>
    ${lineage.size === 1
      ? empty({
          icon: "fork",
          title: "No forks yet",
          note: "A fork is a copy under another name that can propose changes back here, and follows this one until it has work of its own.",
        })
      : html`${forkRanking(ranked, new Map(tree.map((n) => [n.repo.id, n])))}
          <h3 class="mt">The family, by who follows whom</h3>
          ${lineageCard(lineage, repo.id)}`}`;
  const res = page({
    ctx,
    title: `Forks · ${repo.ownerName}/${repo.name}`,
    body,
  });
  notePhase(ctx.request, "render", performance.now() - t);
  return res;
}

/**
 * The forks with work to offer, best first, each linking to the compare
 * view that proposes it upstream; then those with nothing new, counted.
 */
function forkRanking(
  ranked: ForkRanking,
  tree: ReadonlyMap<string, ForkNode>,
): Html {
  const below = (n: ForkNode): Html =>
    row({
      lead: icon("fork"),
      title: html`<a href="/${n.repo.ownerName}/${n.repo.name}"
        >${n.repo.ownerName}/${n.repo.name}</a
      >`,
      ...(n.deeper === 0
        ? {}
        : {
            meta: html`<a href="/${n.repo.ownerName}/${n.repo.name}/forks"
              >and ${n.deeper} more fork${n.deeper === 1 ? "" : "s"} below</a
            >`,
          }),
    });
  const line = (f: RankedFork, offer: boolean): Html =>
    row({
      children: (tree.get(f.fork.id)?.forks ?? []).map(below),
      lead: icon("fork"),
      title: html`<a href="/${f.fork.ownerName}/${f.fork.name}"
        >${f.fork.ownerName}/${f.fork.name}</a
      >`,
      meta: html`${ranked.archived ? "" : driftWords(f.drift)}${f.pushedAt === null
        ? html``
        : html` · pushed ${time(f.pushedAt)}`}`,
      ...(offer
        ? {
            trail: btn("Compare", {
              href: `/${f.fork.ownerName}/${f.fork.name}/pulls/new`,
              size: "sm",
              icon: "merge",
            }),
          }
        : {}),
    });
  const { offering, nothingNew } = ranked;
  return html`${ranked.truncated
      ? html`<p class="muted small">
          Ranking the first ${MAX_RANKED_FORKS} of ${ranked.total} forks.
        </p>`
      : html``}
    ${offering.length === 0
      ? html``
      : listCard(offering.map((f) => line(f, true)))}
    ${nothingNew.length === 0
      ? html``
      : html`${ranked.archived
            ? ""
            : html`<h3 class="mt">${nothingNewHeading(nothingNew.length)}</h3>`}
          ${listCard(nothingNew.map((f) => line(f, false)))}`}`;
}

/** What a guest's own fork is for, on its home: what to do next and how to drop it. */
function contributionBar(repo: Repo): Html {
  const base = repoBase(repo);
  return html`<div class="mt">
    ${listCard([
      row({
        lead: icon("fork"),
        title: "Your copy, for sending changes back",
        meta: html`Change it, then send it for review. Nothing here runs: a person reviews your pull request first.`,
        trail: html`${btn("Send for review", { size: "sm", icon: "merge", href: `${base}/pulls/new` })}
          <form method="post" action="${base}/settings/delete">
            <input type="hidden" name="confirm" value="${repo.ownerName}/${repo.name}" />
            ${btn("Delete this copy", { size: "sm", variant: "outline" })}
          </form>`,
      }),
    ])}
  </div>`;
}

/** The "forked from …" lineage line and a Fork button, for the repo home. */
function forkBar(ctx: Ctx, repo: Repo): Html {
  const user = ctx.auth.user;
  // A guest's fork is help on a public repository, and says so; a private one offers none.
  const guest = user !== undefined && lacks(ctx.app.db, user, "make_it_yours");
  const canFork =
    user !== undefined && user.id !== repo.ownerId && (!guest || repo.visibility === "public");
  // Forge it is for any signed-in person, the owner too: it makes a forge, not a copy in this one.
  const canForge = ctx.auth.user?.kind === "user";
  const forkCount = forksFor(ctx, repo).length;
  if (!canFork && !canForge && forkCount === 0) return html``;
  const forks = row({
    lead: icon("fork"),
    title:
      forkCount > 0
        ? html`<a href="${repoBase(repo)}/forks"
            >${badge(`${forkCount} fork${forkCount === 1 ? "" : "s"}`)}</a
          >`
        : "Forks",
    ...(guest && canFork ? { meta: html`${HELP_BUILD_NEXT}` } : {}),
    trail: html`${canFork
      ? html`<form method="post" action="${repoBase(repo)}/fork">
          ${btn(guest ? HELP_BUILD : "Fork", { size: "sm", icon: "fork" })}
        </form>`
      : html``}${canForge
      ? html`<form method="post" action="${repoBase(repo)}/forge">
          ${btn("Forge it", { size: "sm", icon: "rocket", variant: "outline" })}
        </form>`
        : html``}`,
  });
  return html`<div class="mt">${listCard([forks], { extra: "bare" })}</div>`;
}

// POST /:owner/:name/fork
export async function forkSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const forked = await forkRepo(
    ctx.app,
    ctx.auth.user,
    repo,
    field(form, "name") || undefined,
  );
  if (!forked.ok) {
    const reason =
      isGuestRefusal(forked.error)
        ? GUEST_REFUSALS[forked.error]
        : forked.error === "already_forked"
        ? "You already have a fork of this repository."
        : forked.error === "name_taken"
        ? "You already have a repository by that name."
        : forked.error === "not_member"
        ? `Not made: ${NOT_A_MEMBER}.`
        : forked.error === "unverified"
        ? VERIFY_FIRST
        : forked.error === "repository_limit"
        ? `Not made: ${repositoryLimitMessage(ctx.app, ctx.auth.user)}.`
        : forked.error === "storage_limit"
        ? `Not made: ${storageLimitMessage(ctx.app, ctx.auth.user.id)}.`
        : forked.error === "limit"
          ? `That is today's forks made (${FORKS_PER_DAY} a day). Try again tomorrow.`
          : "That fork could not be created.";
    return flashTo(ctx, repoBase(repo), { tone: "danger", message: reason });
  }
  return flashTo(ctx, repoBase(forked.value), {
    message: isContributionFork(ctx.app.db, forked.value.id)
      ? `This is your copy of ${repo.ownerName}/${repo.name}. Change it, then send it for review.`
      : `Forked to ${forked.value.ownerName}/${forked.value.name}.`,
  });
}

// ---- mirrors and pins ----

// POST /:owner/:name/sync — pull this mirror now. Any writer may ask: it only
// fetches, so it borrows nobody's identity and grants nobody anything.
export async function repoSyncSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  // A native fork takes from its parent; a mirror from its origin.
  if (repo.origin === null && repo.forkParentId !== null) {
    const took = await takeUpdates(ctx.app, ctx.auth.user, repo);
    if (!took.ok) {
      const e = took.error;
      return flashTo(ctx, repoBase(repo), {
        tone: "danger",
        message:
          typeof e === "string"
            ? e === "not_a_fork"
              ? "This repository has no parent to follow."
              : "You need write access to update this fork."
            : e.kind === "conflict"
              ? `${repo.defaultBranch} and the parent both changed ${e.files.join(", ")}; the crew can converge it.`
              : e.kind === "moved"
                ? "Something moved while this was read; try again."
                : `Git could not take the updates: ${e.message}`,
      });
    }
    const parent = forkParent(ctx, repo);
    return flashTo(ctx, repoBase(repo), {
      message: took.value.updated
        ? `${took.value.merged ? "Merged" : "Updated"} ${repo.defaultBranch} to ${took.value.to.slice(0, 7)}.`
        : parent === undefined
          ? "Already up to date with the parent."
          : nothingNew(parent),
    });
  }
  const synced = await syncRepoNow(ctx.app, ctx.auth.user, repo);
  if (!synced.ok) return flashTo(ctx, repoBase(repo), { tone: "danger", message: mirrorRefusal(repo, synced.error) });
  return flashTo(ctx, repoBase(repo), {
    ...(synced.value.error === ""
      ? { message: "Synced from the origin." }
      : { tone: "danger" as const, message: synced.value.error }),
  });
}

/** Why a mirror's sync or take was refused, in the words both say. */
function mirrorRefusal(repo: Repo, error: "unauthorized" | "forbidden" | "not_found"): string {
  return error !== "not_found"
    ? "You need write access to sync this mirror."
    : repo.detached !== null
      ? "This mirror is frozen: its origin was disconnected. Reconnect it first."
      : "This repository does not mirror an origin.";
}

// POST /:owner/:name/sync/take — "Take them" under "N new commits upstream":
// the mirror's sync, asked first, so a default branch holding commits the
// origin lacks is reported as a conflict and nothing moves.
export async function repoTakeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const taken = await takeFromOrigin(ctx.app, ctx.auth.user, repo);
  if (!taken.ok) return flashTo(ctx, repoBase(repo), { tone: "danger", message: mirrorRefusal(repo, taken.error) });
  const t = taken.value;
  if (t.kind === "conflict")
    return flashTo(ctx, repoBase(repo), { tone: "danger", message: CONFLICT_WORDS(repo.defaultBranch, t.count) });
  if (t.kind === "unread") return flashTo(ctx, repoBase(repo), { tone: "danger", message: UNREAD_WORDS });
  return flashTo(ctx, repoBase(repo), {
    ...(t.report.error === ""
      ? { message: `Took ${t.count} new commit${t.count === 1 ? "" : "s"} from the origin.` }
      : { tone: "danger" as const, message: t.report.error }),
  });
}

/**
 * POST /:owner/:name/pin — "keep this on my machine", toggled.
 *
 * The state being asked for travels in the form rather than being read back
 * out of the database, so a double submit is idempotent instead of a
 * flip-flop.
 */
export async function pinSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;

  const wanted = field(form, "pinned") !== "0";
  const done = wanted
    ? pinRepo(ctx.app, ctx.auth.user, repo)
    : unpinRepo(ctx.app, ctx.auth.user, repo);
  const back = safeBack(ctx) ?? repoBase(repo);
  if (!done.ok && wanted)
    return flashTo(ctx, back, {
      tone: "danger",
      message: "That could not be pinned.",
    });
  return flashTo(ctx, back, {
    message: wanted
      ? "Pinned. The local client keeps it cloned on your machine."
      : "Unpinned.",
  });
}

// ---- shared pieces ----

/**
 * One directory level. Takes a URL base rather than a repository, so the same
 * listing renders for a repo we hold and for one we are reading live off
 * another forge — the rows differ only in where they point.
 */
export function treeListing(
  base: string,
  ref: string,
  path: string,
  entries: readonly TreeEntry[],
  all = false,
): Html {
  const encoded = encodeURIComponent(ref);
  const shown = all ? entries : treeWindow(entries);
  const hidden = entries.length - shown.length;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const rows: Html[] = [];
  if (path !== "") {
    rows.push(
      row({
        href: `${base}/tree/${encoded}${parent === "" ? "" : `/${parent}`}`,
        lead: icon("up"),
        title: html`<span class="muted">..</span>`,
        nav: true,
      }),
    );
  }
  for (const entry of shown) {
    const target = path === "" ? entry.name : `${path}/${entry.name}`;
    const isTree = entry.type === "tree";
    rows.push(
      row({
        href: `${base}/${isTree ? "tree" : "blob"}/${encoded}/${target}`,
        lead: icon(isTree ? "folder" : "file"),
        title: entry.name,
        trail:
          entry.size >= 0
            ? html`<span class="muted small num"
                >${sizeWithTokens(entry.size, target)}</span
              >`
            : html``,
        nav: true,
        data: { kind: entry.type },
      }),
    );
  }
  if (hidden > 0) {
    rows.push(
      row({
        href: `${base}/tree/${encoded}${path === "" ? "" : `/${path}`}?all=1`,
        title: html`Show all ${entries.length.toLocaleString("en-US")} entries`,
        nav: true,
      }),
    );
  }
  const total = directoryTotal(entries);
  const foot =
    hidden > 0
      ? html`<span class="muted small num"
            >Showing ${shown.length.toLocaleString("en-US")} of
            ${entries.length.toLocaleString("en-US")} entries</span
          >
          ${total}`
      : total;
  const options: CardOptions = { extra: "bare" };
  if (foot.text.trim() !== "") options.foot = foot;
  return listCard(rows, options);
}

/**
 * What the files at this level weigh together: bytes and estimated tokens,
 * the two summed over the same files. Subdirectories carry no size in a
 * tree listing (`git ls-tree -l` gives `-`), so they are not in it — the
 * line says "here" and the tooltip says why. Binary files add bytes but no
 * tokens. Nothing when there are no files.
 */
export function directoryTotal(entries: readonly TreeEntry[]): Html {
  let files = 0;
  let bytes = 0;
  let tokens = 0;
  for (const entry of entries) {
    if (entry.type !== "blob" || entry.size < 0) continue;
    files += 1;
    bytes += entry.size;
    tokens += estimateTokens(entry.size, entry.name) ?? 0;
  }
  if (files === 0) return html``;
  return html`<span
    class="muted small num"
    title="Files at this level only; subdirectories are not counted"
  >
    ${files.toLocaleString("en-US")} file${files === 1 ? "" : "s"} here ·
    ${fileSize(bytes)} · ${tokenCount(tokens, "estimated")}
  </span>`;
}

/**
 * Rendered README cards by blob oid. An oid names its bytes for good, so an
 * entry never goes stale; the cache is bounded by the bytes of source behind
 * the entries it holds, oldest out first.
 */
const README_CACHE_BYTES = 8_000_000;
const readmeCache = new Map<string, { card: Html; bytes: number }>();
let readmeCacheBytes = 0;

function remember(key: string, card: Html, bytes: number): void {
  if (bytes > README_CACHE_BYTES) return;
  const old = readmeCache.get(key);
  if (old) {
    readmeCacheBytes -= old.bytes;
    readmeCache.delete(key);
  }
  readmeCache.set(key, { card, bytes });
  readmeCacheBytes += bytes;
  for (const [k, v] of readmeCache) {
    if (readmeCacheBytes <= README_CACHE_BYTES) break;
    readmeCache.delete(k);
    readmeCacheBytes -= v.bytes;
  }
}

/**
 * Whose bytes an entry holds: the repository being read, then the oid and
 * name. An origin's oid is whatever the remote host sent, so it is never
 * trusted alone, and one that is not a real object id is not cached at all.
 */
function readmeKey(source: RepoSource, entry: TreeEntry): string | null {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(entry.oid)) return null;
  const w = source.where;
  const repo =
    w.kind === "local"
      ? `local:${w.repo.id}`
      : `origin:${w.origin.id}:${w.fullName}`;
  return `${repo}:${entry.oid}:${entry.name}`;
}

/** How much README source the repository home draws before linking the rest. */
export const README_HOME_BYTES = 64 * 1024;

/**
 * The README source up to `limit` bytes, cut between top-level blocks: at the
 * last blank line outside a fenced code block, so no fence is ever split.
 * Null when the whole text fits.
 */
export function cutAtBlock(text: string, limit: number): string | null {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return null;
  const head = new TextDecoder().decode(bytes.subarray(0, limit));
  const lines = head.split("\n");
  lines.pop(); // the last line may be cut mid-way
  let fence = "";
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]!);
    if (m) {
      if (fence === "") fence = m[1]!;
      else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = "";
    } else if (fence === "" && lines[i]!.trim() === "") cut = i;
  }
  return cut < 0 ? "" : lines.slice(0, cut).join("\n");
}

/** Empties the README cache; for tests. */
export function clearReadmeCache(): void {
  readmeCache.clear();
  readmeCacheBytes = 0;
}

/**
 * The README under a directory listing, read through whichever source is
 * answering. It is found in the entries we already have rather than by asking
 * for the tree again — `RepoSource.readme` only knows the root, and a README
 * two directories down is exactly as worth rendering.
 */
export async function readmeFor(
  source: RepoSource,
  ref: string,
  entries: readonly TreeEntry[],
  prefix: string,
  /** The blob base of the whole README; when given, a long one is cut and links there. */
  whole?: string,
): Promise<Html> {
  const readme = entries.find(
    (e) =>
      e.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name),
  );
  if (!readme) return html``;
  const baseKey = readmeKey(source, readme);
  const key = baseKey === null || whole === undefined ? baseKey : `${baseKey}:${whole}`;
  const cached = key === null ? undefined : readmeCache.get(key);
  if (key !== null && cached) {
    readmeCache.delete(key);
    readmeCache.set(key, cached);
    return cached.card;
  }
  const at = prefix === "" ? readme.name : `${prefix}/${readme.name}`;
  const blob = await source.blob(ref, at);
  if (!blob.ok || blob.value.kind !== "text") return html``;
  if (blob.value.size > MAX_RENDER_BYTES) return html``;
  const full = new TextDecoder().decode(blob.value.body);
  const cut = whole === undefined ? null : cutAtBlock(full, README_HOME_BYTES);
  const text = cut ?? full;
  const rendered = /\.(md|markdown)$/i.test(readme.name)
    ? renderMarkdown(text)
    : html`<pre>${text}</pre>`;
  const more =
    cut === null
      ? html``
      : html`<p><a href="${`${whole}/${at.split("/").map(encodeURIComponent).join("/")}`}">Read the whole README</a></p>`;
  const made = card(html`<div class="prose">${rendered}${more}</div>`, {
    extra: "bare",
    pad: false,
    head: html`${icon("file")}
      <h2>${readme.name}</h2>`,
  });
  if (key !== null) remember(key, made, blob.value.size + key.length);
  return made;
}

/**
 * A Markdown file has two right answers — the prose it becomes and the text
 * you would edit — so the page offers both and defaults to the one people
 * came for. `?view=source` is a plain link, so both halves work with no
 * JavaScript, are addressable, and survive being sent to somebody.
 */
export type BlobView = "source" | "rendered";

export function blobView(value: string | null): BlobView {
  return value === "source" ? "source" : "rendered";
}

/** One file, in each of the three states a source can hand one back in. */
export function blobBody(
  base: string,
  ref: string,
  path: string,
  blob: Blob,
  highlighted?: (ms: number) => void,
  all = false,
  ready?: CodeRows,
  why?: string,
): { content: Html; lines: number } {
  const encoded = encodeURIComponent(ref);
  if (blob.kind === "binary") {
    return {
      lines: 0,
      content: empty({
        icon: "file",
        title: why !== undefined ? "Archive" : "Binary file",
        note: why !== undefined ? `${fileSize(blob.size)} · ${why}` : `${fileSize(blob.size)} — not shown, but you can download it.`,
        action: btn("Download", {
          href: downloadHref(base, ref, path),
          variant: "primary",
          icon: "download",
        }),
      }),
    };
  }
  if (blob.kind === "too_large") {
    return {
      lines: 0,
      content: empty({
        icon: "alert",
        title: "Too large to render",
        note: why !== undefined ? `${fileSize(blob.size)} — ${why}` : `${fileSize(blob.size)} — over the render cap. Download it instead.`,
        action: btn("Download", {
          href: downloadHref(base, ref, path),
          variant: "primary",
          icon: "download",
        }),
      }),
    };
  }
  const limit = all ? MAX_RENDER_LINES : FIRST_LINES;
  // Highlighting runs left to right, so the first N lines highlight the same
  // alone as inside the whole file; only that prefix is read and painted.
  let total: number;
  let shown: number;
  let rows: string;
  if (ready !== undefined) ({ total, shown, rows } = ready);
  else {
    const text = new TextDecoder().decode(blob.body).replace(/\n$/, "");
    const began = performance.now();
    total = countLines(text);
    const lines = highlightPrefix(text, path, limit);
    highlighted?.(performance.now() - began);
    shown = lines.length;
    rows = rowsMarkup(lines);
  }
  const truncated = total > shown;
  const fileHref = `${base}/blob/${encoded}/${path}`;
  return {
    lines: total,
    content: html`${why !== undefined ? html`<p class="nb-cap">${why}</p>` : html``}<div class="card code">
        <table>
          ${raw(rows)}
        </table>
      </div>
      ${when(truncated, () =>
        empty({
          icon: "file",
          title: `${(total - shown).toLocaleString("en-US")} more lines`,
          note: all
            ? "The rest is in the raw file."
            : "The page draws the first lines so it opens at once. A link to a later line (#L…) lands once you show all lines.",
          action: html`${all
              ? html``
              : btn("Show all lines", {
                  href: `${fileHref}?all=1`,
                  id: "code-cut",
                  icon: "file",
                })}
            ${btn("View raw", {
              href: `${base}/raw/${encoded}/${path}`,
              variant: "outline",
            })}`,
        }),
      )}`,
  };
}

/** The ref switcher and the History link every code page carries. */
export function codeBar(
  refs: RefSet,
  ref: string,
  hrefFor: (r: string) => string,
  historyHref: string,
  menu: { base?: string; canWrite?: boolean } = {},
): Html {
  return html`${refMenu(refs, ref, hrefFor, menu)}
  ${btn("History", {
    href: historyHref,
    size: "sm",
    variant: "outline",
    icon: "history",
  })}`;
}

/**
 * One fact of the About column: a `dl` pair, the label over its value. The
 * rail is narrower than `.status-row`'s 168px label column, so it stacks and
 * separates the facts with space, not a rule per row.
 */
function fact(label: string, value: Html): Html {
  return html`<div class="rail-fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

/**
 * The About rail: what this repo is, in one glance, plus how to clone it.
 *
 * On a mirror, everything about the origin sits in one "Where it lives"
 * block — where it comes from, when it last came, the button that fetches it
 * now, and where a push actually lands. Those four facts used to be spread
 * across three parts of the card, which is how someone ends up pushing to a
 * mirror without knowing the origin gets the last word.
 *
 * `drift` is how far the fork has slipped from its parent, read by the caller
 * (git, so asynchronous); `undefined` on anything that is not a native fork.
 */
function aboutCard(
  ctx: Ctx,
  repo: Repo,
  refs: RefSet,
  drift?: ForkDrift,
): Html {
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  const sshUrl = sshCloneUrl(ctx.app, repo.ownerName, repo.name);
  const parent = forkParent(ctx, repo);
  const origin = repo.origin;
  // A fork made at the origin has no `forkParentId` — its parent is a
  // repository on another forge — so the lineage row reads it off the link
  // the fork flow wrote, and points at the live browse of the upstream.
  const upstream = repoForkOf(ctx.app.db, repo.id);
  const upstreamHref =
    upstream === null || origin === null
      ? undefined
      : browseBase(origin.originId, upstream);
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  const whereItLives = when(
    origin,
    (o) =>
      html`<div class="where-block">
        <h3>Where it lives</h3>
        <ul class="list setting-list">
          ${row({
            title: "Origin",
            trail:
              o.htmlUrl === ""
                ? html`${o.fullName}`
                : html`<a href="${o.htmlUrl}" rel="noreferrer noopener"
                    >${o.fullName}</a
                  >`,
          })}
          ${row({
            title: "Last fetch",
            trail: html`${o.lastFetchAt === null ? "never" : time(o.lastFetchAt)}`,
          })}
        </ul>
        ${when(
          o.fetchError !== "",
          () => html`<div class="toast" data-tone="danger" role="status">
            ${icon("alert")}
            <div class="toast-body">${o.fetchError}</div>
          </div>`,
        )}
        ${when(
          admin,
          () =>
            html`<form method="post" action="${repoBase(repo)}/sync" class="mt">
              ${btn("Sync now", { size: "sm", icon: "sync" })}
            </form>`,
        )}
        <p class="mt small muted">
          Pushes here go through to
          <span class="mono">${o.fullName}</span> first — if the origin refuses
          one, nothing lands locally either.
        </p>
      </div>`,
  );
  return html`<section class="settings-block">
    <h2>About</h2>
    ${when(
      repo.description !== "",
      () => html`<p class="mb">${repo.description}</p>`,
    )}
    <dl class="rail-facts">
      ${fact("Visibility", html`${repo.visibility}`)}
      ${fact("Default", html`<span class="mono">${repo.defaultBranch}</span>`)}
      ${fact("Protection", html`${repo.protectDefault ? "on" : "off"}`)}
      ${fact("Branches", html`<span class="num">${refs.branches.length}</span>`)}
      ${when(
        refs.tags.length > 0,
        () =>
          fact("Tags", html`<span class="num">${refs.tags.length}</span>`),
      )}
      ${when(
        parent,
        (p) =>
          // The standing and the one thing to do about it live in the
          // Following card above the code; the rail only names the parent.
          fact(
            "Fork of",
            html`<a href="/${p.ownerName}/${p.name}">${p.ownerName}/${p.name}</a>`,
          ),
      )}
      ${when(
        upstream,
        (up) =>
          fact(
            "Fork of",
            upstreamHref === undefined
              ? html`<span class="mono">${up}</span>`
              : html`<a href="${upstreamHref}">${up}</a>`,
          ),
      )}
    </dl>
    ${followingLine(ctx, repo)}
    ${whereItLives}
    ${when(
      repo.visibility === "public" && repo.origin === null,
      () =>
        html`<p class="mt small muted">
          ${icon("lock")} Found a security problem?
          <a href="${repoBase(repo)}/issues/new?sealed=1"
            >Report it sealed</a
          >: only the people who keep this repository and its crew see it
          until the fix is released.
        </p>`,
    )}
    <p class="mt small muted">Clone over HTTPS</p>
    ${copyField("clone-https", cloneUrl, "HTTPS clone address", "Copy clone URL")}
    ${when(
      sshUrl,
      (url) =>
        html`<p class="mt small muted">Clone over SSH</p>
          ${copyField(
            "clone-ssh",
            url,
            "SSH clone address",
            "Copy SSH clone URL",
          )}`,
    )}
  </section>`;
}

// ---- pages ----

/**
 * Studio's own word for a repository it otherwise has nothing to say about:
 * no app record, so no head card, no box, no Now — just the code underneath,
 * same as it always rendered. One line says so, and the one door out —
 * `/settings/app`, the same "Run as an app" form Settings already carries —
 * opens only for whoever could actually submit it, so a reader never sees a
 * button that would just come back refused.
 */
function noAppCard(ctx: Ctx, repo: Repo): Html {
  const admin = canAdmin(ctx.app.db, repo, ctx.auth.user);
  return empty({
    icon: "rocket",
    title: "This repository has no app yet.",
    ...(admin
      ? {
          action: btn("Run as an app", {
            href: `${repoBase(repo)}/settings/app`,
            variant: "primary",
            icon: "rocket",
          }),
        }
      : {}),
  });
}

/** The tree, the README under it, and the ref switcher above both. */
export async function renderCode(
  scope: RepoScope,
  o: {
    refs: RefSet;
    ref: string;
    path: string;
    entries: readonly TreeEntry[];
    /** List every entry, not the first TREE_WINDOW (`?all=1`). */
    all?: boolean;
    extra?: Html;
    rail?: Html;
    /** The README, when the caller has already read it (and timed the read). */
    readme?: Html;
    /** What the listing's links name instead of `ref`: a full commit id, whose pages a cache may keep (#8199). */
    linkRef?: string;
  },
): Promise<Html> {
  const base = scope.base;
  const { ref, path } = o;
  const linked = o.linkRef ?? ref;
  const readme =
    o.readme ??
    (await readmeFor(scope.source, linked, o.entries, path, `${base}/blob/${encodeURIComponent(linked)}`));
  const historyParams = new URLSearchParams({ ref });
  if (path !== "") historyParams.set("path", path);
  const bar =
    path === ""
      ? html`<div class="bar mb">
          ${codeBar(
            o.refs,
            ref,
            (r) => `${base}?ref=${encodeURIComponent(r)}`,
            `${base}/commits?${historyParams.toString()}`,
            { base, canWrite: scope.caps.write },
          )}
          <span class="spacer"></span>
          ${finderButton()}
        </div>`
      : html`<div class="bar mb">
          ${refMenu(
            o.refs,
            ref,
            (r) => `${base}/tree/${encodeURIComponent(r)}/${path}`,
            { base, canWrite: scope.caps.write },
          )}
          ${pathCrumbs(base, scope.facts.name, ref, path, false)}
          <span class="spacer"></span>
          ${btn("History", {
            href: `${base}/commits?${historyParams.toString()}`,
            size: "sm",
            variant: "outline",
            icon: "history",
          })}
        </div>`;
  const main = html`${bar} ${o.extra ?? null}
    ${treeListing(base, linked, path, o.entries, o.all === true)}
    <div class="mt">${readme}</div>`;
  return o.rail === undefined
    ? main
    : html`<div class="split">
        <div>${main}</div>
        <aside aria-label="About">${o.rail}</aside>
      </div>`;
}

/**
 * What a file page offers besides reading it.
 *
 * Three situations, one button. On a repository we hold and may push, it is
 * Edit. On one whose origin says we may not — a live browse, or a mirror of
 * somebody else's repository — it is **Propose a change**, which is the same
 * editor with a fork and a pull request behind the button. Nothing
 * disappears, because "you cannot change this" is never the whole truth: you
 * can always propose it.
 */
export function editAction(scope: RepoScope, ref: string, path: string): Html {
  const encoded = encodeURIComponent(ref);
  if (scope.propose !== undefined) {
    return btn("Propose a change", {
      href: `${scope.base}/edit/${encoded}/${path}`,
      size: "sm",
      variant: "outline",
      icon: "fork",
      shortcut: "e",
      title: `You cannot push to ${scope.propose.upstream} — this lands on your fork and opens a pull there`,
    });
  }
  if (scope.kind === "origin") {
    const mirror = scope.mirror;
    return btn("Mirror to edit", {
      href:
        mirror === undefined
          ? scope.base
          : `/${mirror.ownerName}/${mirror.name}/edit/${encoded}/${path}`,
      size: "sm",
      variant: "outline",
      icon: mirror === undefined ? "download" : "pencil",
      title:
        mirror === undefined
          ? "This repository is read-only here. Mirror it into your workbench to edit it."
          : "Edit this file in the mirror",
    });
  }
  if (!scope.caps.write) return html``;
  return btn("Edit", {
    href: `${scope.base}/edit/${encoded}/${path}`,
    size: "sm",
    variant: "outline",
    icon: "pencil",
    shortcut: "e",
  });
}

/**
 * What draws this file, if anything: the registry decides what it is and
 * whether it is under its cap; a kind with no renderer yet, or one over its
 * cap, keeps the source view. A PDF is drawn from the media route, which only
 * a repository on this forge has.
 */
function blobRenderer(scope: RepoScope, path: string, blob: Blob): ReturnType<typeof rendererFor> {
  const found = rendererFor(path, blob, RENDERERS, { media: scope.kind === "local" });
  return found?.render === RENDERERS.pdf && scope.kind !== "local" ? undefined : found;
}

/** Why an archive too big to list is not listed, as one sentence. */
function overCap(path: string, blob: Blob): string | undefined {
  if (kindByName(path) === "notebook" && blob.size > RENDER_CAP.notebook)
    return `This notebook is over ${RENDER_CAP.notebook / 1_000_000} MB, so it is not drawn as cells${blob.kind === "too_large" ? ". Download it to read it" : " and is shown as plain text"}.`;
  if (blob.kind !== "binary" || fileKind(path, blob.body.subarray(0, HEAD_BYTES)) !== "archive") return undefined;
  return blob.size > RENDER_CAP.archive ? overSize(RENDER_CAP.archive) : undefined;
}

/** Whether the blob page of this file draws a PDF, and so needs `object-src`. */
export function drawsPdf(scope: RepoScope, path: string, blob: Blob, view: BlobView): boolean {
  return (
    view !== "source" &&
    RENDERERS.pdf !== undefined &&
    blobRenderer(scope, path, blob)?.render === RENDERERS.pdf
  );
}

/** Whether the blob page of this file sets a font in itself, and so needs `font-src`. */
export function drawsFont(scope: RepoScope, path: string, blob: Blob, view: BlobView): boolean {
  return (
    view !== "source" &&
    RENDERERS.font !== undefined &&
    blobRenderer(scope, path, blob)?.render === RENDERERS.font
  );
}

/**
 * One file, framed by the same path header the tree uses. The header is
 * sticky and the whole pane is one element, because a script swapping a
 * preview in replaces exactly this.
 */
export function renderBlob(
  scope: RepoScope,
  o: {
    refs: RefSet;
    ref: string;
    path: string;
    blob: Blob;
    view?: BlobView;
    /** Told how long highlighting took, for Server-Timing. */
    highlighted?: (ms: number) => void;
    /** Draw every line instead of the first 1,500. */
    all?: boolean;
    /** `?table=` on a SQLite file. */
    table?: string;
    /** Rows a worker already built for this file. */
    rows?: CodeRows;
  },
): Html {
  const base = scope.base;
  const encoded = encodeURIComponent(o.ref);
  const blob = o.blob;
  const renderer = blobRenderer(scope, o.path, blob);
  const view: BlobView = renderer ? (o.view ?? "rendered") : "source";
  const drawn =
    view === "rendered" && renderer
      ? renderer.render({
          path: o.path,
          size: blob.size,
          body: renderer.body,
          media: mediaHref(base, o.ref, o.path),
          download: downloadHref(base, o.ref, o.path),
          pathHref: `${base}/blob/${encoded}/${o.path}`,
          all: o.all === true,
          ...(o.table !== undefined ? { table: o.table } : {}),
        })
      : undefined;
  const fellBack = drawn?.fallback;
  const { content, lines, summary } =
    drawn !== undefined && fellBack === undefined
      ? drawn
      : {
          ...blobBody(base, o.ref, o.path, blob, o.highlighted, o.all, o.rows, fellBack ?? overCap(o.path, blob)),
          summary: undefined,
        };
  const sizeText =
    blob.kind === "too_large" ? "" : sizeWithTokens(blob.size, o.path);
  const fileHref = `${base}/blob/${encoded}/${o.path}`;
  return html`<div class="code-pane" id="code-pane" data-path="${o.path}">
    <div class="bar mb">
      ${refMenu(
        o.refs,
        o.ref,
        (r) => `${base}/blob/${encodeURIComponent(r)}/${o.path}`,
        { base, canWrite: scope.caps.write },
      )}
      ${pathCrumbs(base, scope.facts.name, o.ref, o.path, true)}
      <span class="spacer"></span>
      ${summary !== undefined
        ? html`<span class="muted small num">${summary}</span>`
        : when(
            lines > 0,
            () =>
              html`<span class="muted small num"
                >${lines.toLocaleString()} lines · ${sizeText}</span
              >`,
          )}
      ${when(
        renderer !== undefined,
        () =>
          html`<span class="blob-view"
            >${seg([
              {
                label: "Rendered",
                href: fileHref,
                current: view === "rendered" && fellBack === undefined,
              },
              {
                label: "Source",
                href: `${fileHref}?view=source`,
                current: view === "source" || fellBack !== undefined,
              },
            ])}</span
          >`,
      )}
      ${btn("Raw", {
        href: `${base}/raw/${encoded}/${o.path}`,
        size: "sm",
        variant: "outline",
      })}
      ${btn("Download", {
        href: downloadHref(base, o.ref, o.path),
        size: "sm",
        variant: "outline",
        icon: "download",
      })}
      ${btn("History", {
        href: `${base}/commits?ref=${encoded}&path=${encodeURIComponent(o.path)}`,
        size: "sm",
        variant: "outline",
        icon: "history",
      })}
      ${editAction(scope, o.ref, o.path)}
    </div>
    ${when(
      fellBack !== undefined,
      () => html`<p class="muted small mb">Showing the source: ${fellBack}</p>`,
    )}
    ${content}
  </div>`;
}

/** The bytes, with the headers that stop them ever executing as a page. */
export function rawResponse(
  blob: Blob,
  cache: {
    oid?: string;
    immutable?: boolean;
    public?: boolean;
    request?: Request;
  } = {},
): Response {
  if (blob.kind === "too_large") return new Response("", { status: 404 });
  // A full commit id names bytes that can never change; a branch name does
  // not, so it revalidates every time, against the blob's own oid. Only an
  // anonymous request's copy of a public repository's bytes may sit in a
  // shared cache (`mayShare`).
  const etag = cache.oid ? `"${cache.oid}"` : undefined;
  const control =
    cache.immutable && etag
      ? cache.public
        ? PINNED_PUBLIC
        : "private, max-age=31536000, immutable"
      : "private, max-age=0";
  const headers: Record<string, string> = {
    "content-type":
      blob.kind === "text"
        ? "text/plain; charset=utf-8"
        : "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": control,
    ...(cache.immutable && etag && cache.public ? { vary: EDGE_VARY } : {}),
  };
  if (etag) {
    headers.etag = etag;
    if (cache.request && holds(cache.request, etag))
      return new Response(null, { status: 304, headers });
  }
  return new Response(blob.body, { headers });
}

/** A forge admin looking at a repository is counted, to suggest a valve on /flow and never to set one. */
function noteLook(ctx: Ctx, repoId: string): void {
  const user = ctx.auth.user;
  if (user?.isAdmin === true && user.kind !== "agent") recordLook(ctx.app.db, user.id, repoId);
}

// GET /:owner/:name — the repo home. An app's home is the app, for every
// viewer: what it serves, who is on it, what it asks; its code is one tab
// deeper, at /files. Any other repository's home is its code. An older
// `?ref=` link to the code of an app is handed on to its Files step.
export async function repoHome(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  noteLook(ctx, repo.id);
  const record = getAppByRepo(ctx.app.db, repo.id);
  if (record === undefined) return await codeHome(ctx, repo);
  if (ctx.url.searchParams.has("ref"))
    return redirect(`${repoBase(repo)}/files${ctx.url.search}`);
  return await studioApp(ctx, repo, record);
}

// GET /:owner/:name/files — an app's Files step: its code, exactly the page
// any other repository's home is. A repository that is not an app has no
// step under a home that is already its code, so it is sent there.
export async function repoFiles(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (getAppByRepo(ctx.app.db, repo.id) === undefined)
    return redirect(`${repoBase(repo)}${ctx.url.search}`);
  return await codeHome(ctx, repo);
}

/** "Moved from <old path> on <date>" for 30 days after a move; one muted line. */
function movedLine(ctx: Ctx, repo: Repo): Html | null {
  const move = recentMove(ctx.app.db, repo.id);
  if (move === undefined) return null;
  return html`<p class="muted small moved-from">Moved from ${move.from} on ${time(move.at, { date: true })}</p>`;
}

/**
 * "Archived on <date>" with, for an admin, the Restore button. A repository put
 * away still clones, pushes and links as before; this only says so.
 */
function archivedLine(ctx: Ctx, repo: Repo): Html | null {
  if (repo.archivedAt === null) return null;
  return html`<div class="mt archived">
    <p>
      Archived on
      <time datetime="${repo.archivedAt}">${repo.archivedAt.slice(0, 10)}</time>
    </p>
    ${when(
      canAdmin(ctx.app.db, repo, ctx.auth.user),
      () => html`<form method="post" action="${repoBase(repo)}/settings/archive">
        <input type="hidden" name="archived" value="0" />
        <input type="hidden" name="to" value="repo" />
        ${btn("Restore", { size: "sm" })}
      </form>`,
    )}
  </div>`;
}

/** The code at a ref: the tree, the README and the About rail — with, in
 * the studio, the offer to make a repository that is not an app one. */
async function codeHome(ctx: Ctx, repo: Repo): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const isApp = timePhase(ctx.request, "appof", () => getAppByRepo(ctx.app.db, repo.id) !== undefined);
  const noApp = isApp ? null : noAppCard(ctx, repo);
  const scope = localScope(ctx, repo);
  const cloneUrl = `${ctx.url.origin}/${repo.ownerName}/${repo.name}.git`;
  const refs = await timePhaseAsync(ctx.request, "refs", () => refSetFrom(scope.source));

  if (refs.branches.length === 0) {
    const emptyRendering = performance.now();
    const body = html`${scopeHeader(ctx, scope, "code")}${archivedLine(ctx, repo)}${movedLine(ctx, repo)}${noApp}
      <div class="mt">
        ${empty({
          icon: "repo",
          title: "An empty repository, ready for its first push",
          note: "Point a local repository at it and push — the first branch you push becomes the code you see here.",
        })}
        <section class="settings-block">
          <h2>Get started</h2>
          ${copyField(
            "clone-https",
            `git remote add origin ${cloneUrl} && git push -u origin ${repo.defaultBranch}`,
            "Get started command",
            "Copy the get started command",
          )}
        </section>
      </div>`;
    const emptyResponse = page({
      ctx,
      title: repo.name,
      description: repoLine({ private: repo.visibility === "private", name: repo.name, description: repo.description }),
      ogImage: `/og/repo/${repo.ownerName}~${repo.name}.png`,
      about: `${repo.ownerName}/${repo.name}`,
      feed: {
        href: `${repoBase(repo)}/activity.atom`,
        title: `${repo.ownerName}/${repo.name} activity`,
      },
      crumbs: scope.crumbs,
      palette: scope.palette,
      body,
    });
    notePhase(ctx.request, "render", performance.now() - emptyRendering);
    return emptyResponse;
  }

  const wanted = ctx.url.searchParams.get("ref");
  const ref =
    wanted !== null && isSafeRef(wanted) && knownRef(refs, wanted)
      ? wanted
      : knownRef(refs, repo.defaultBranch)
        ? repo.defaultBranch
        : refs.branches[0]!;
  // A fork's rail says how far its default branch is from its parent's; the
  // count is git's, so it is read here rather than inside the card — beside
  // the tree read, not after it, because neither waits on the other.
  const parent = forkParent(ctx, repo);
  const [entries, drift] = await Promise.all([
    timePhaseAsync(ctx.request, "tree", () => scope.source.tree(ref, "")),
    parent === undefined || parent.archivedAt !== null
      ? undefined
      : timePhaseAsync(ctx.request, "drift", () => forkDrift(ctx.app, repo, parent)),
  ]);
  const tree = entries.ok ? entries.value : [];

  const readme = await timePhaseAsync(ctx.request, "readme", () =>
    readmeFor(scope.source, ref, tree, "", `${scope.base}/blob/${encodeURIComponent(ref)}`),
  );
  const following = await timePhaseAsync(ctx.request, "following", () => followingOf(ctx, repo));
  const latest = await timePhaseAsync(ctx.request, "wave", () =>
    latestWave(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), repo.defaultBranch),
  );
  // The Following card's "Propose upstream" is a writer's route to the same
  // pull; a writer who has the card is not offered a second button.
  const offer =
    following !== undefined && canWrite(ctx.app.db, repo, ctx.auth.user)
      ? null
      : upstreamOffer(ctx.app, ctx.auth.user, repo, parent, drift?.ahead);
  const declares = isApp && (await timePhaseAsync(ctx.request, "feature", () => declaresFeature(ctx.app, ctx.auth.user, repo)));
  const credit = await timePhaseAsync(ctx.request, "credit", () =>
    creditLine(ctx, repo, scope.source, ref),
  );
  const rendering = performance.now();
  const body = html`${scopeHeader(ctx, scope, "code", {
    branchCount: refs.branches.length,
  })}${credit}${timePhase(ctx.request, "behind", () => behindLine(ctx, repo))}${originAheadLine(ctx, repo)}${archivedLine(ctx, repo)}${movedLine(ctx, repo)}${noApp}
  ${offerUpstream(repo, parent, offer)}
  ${latest === null
    ? ""
    : html`<p class="muted latest-wave">Latest:
        <a href="${repoBase(repo)}/waves/${encodeURIComponent(latest.version)}">${latest.version}</a>
        · ${latest.headline} · ${latest.date}</p>`}
  ${frozenBlock(ctx, repo)} ${appStrip(ctx, repo, declares)}
  ${ctx.auth.user?.id === repo.ownerId && isContributionFork(ctx.app.db, repo.id)
    ? contributionBar(repo)
    : following === undefined
      ? html`${archivedParentLine(ctx, repo)}${forkBar(ctx, repo)}`
      : followingCard(ctx, repo, following, { bare: true })}
  ${await renderCode(scope, {
    refs,
    ref,
    path: "",
    entries: tree,
    readme,
    rail: aboutCard(ctx, repo, refs, drift),
  })}
  ${codeMount(scope, ref)} ${finderDialog()} ${liveMount({ repo: scope.base })}`;
  const response = page({
    ctx,
    title: repo.name,
    description: repoLine({ private: repo.visibility === "private", name: repo.name, description: repo.description }),
    ogImage: `/og/repo/${repo.ownerName}~${repo.name}.png`,
    about: `${repo.ownerName}/${repo.name}`,
    feed: {
      href: `${repoBase(repo)}/activity.atom`,
      title: `${repo.ownerName}/${repo.name} activity`,
    },
    crumbs: scope.crumbs,
    palette: scope.palette,
    body,
    scriptJs: `${codeJs}\n${liveClientJs}`,
  });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

function knownRef(refs: RefSet, name: string): boolean {
  return refs.branches.includes(name) || refs.tags.includes(name);
}

/**
 * The explorer's "New file" affordance, for a writer standing in a folder —
 * or, where the origin says you cannot push, its propose twin.
 */
export function newFileAction(
  scope: RepoScope,
  ref: string,
  dir: string,
): Html {
  const encoded = encodeURIComponent(ref);
  const href = `${scope.base}/new/${encoded}${dir === "" ? "" : `/${dir}`}`;
  if (scope.propose !== undefined)
    return btn("Propose a new file", {
      href,
      size: "sm",
      variant: "ghost",
      icon: "fork",
    });
  if (!scope.caps.write || scope.kind !== "local") return html``;
  return btn("New file", {
    href,
    size: "sm",
    variant: "ghost",
    icon: "filePlus",
  });
}

/**
 * The code browser's frame: the explorer column, the content beside it, and
 * the finder dialog that both the button and `t` open. Every code page —
 * ours and a live browse — goes through here, so the two can never drift.
 */
export function codePage(
  ctx: Ctx,
  scope: RepoScope,
  o: {
    title: string;
    ref: string;
    explorer: Html;
    content: Html;
    header?: Html;
    before?: Html;
    /** The page draws a PDF in an `<object>` (`PageOptions.objectSrc`). */
    objectSrc?: boolean;
    /** The page sets a font in itself (`PageOptions.fontSrc`). */
    fontSrc?: boolean;
    /** Script only some files need (the CSV table's sort and filter). */
    extraJs?: string;
  },
): Response {
  return page({
    ctx,
    title: o.title,
    ...(o.objectSrc ? { objectSrc: true } : {}),
    ...(o.fontSrc ? { fontSrc: true } : {}),
    crumbs: scope.crumbs,
    palette: scope.palette,
    body: html`${o.header ?? scopeHeader(ctx, scope, "code", { compact: true })}
    ${o.before ?? null} ${codeLayout(o.explorer, o.content)}
    ${codeMount(scope, o.ref)} ${finderDialog()}`,
    scriptJs: o.extraJs === undefined ? codeJs : `${codeJs}\n${o.extraJs}`,
    wide: true,
  });
}

/**
 * The object reads of one request, summed: Server-Timing names `git` once,
 * however many reads the page made.
 */
function gitClock(request: Request): {
  read: <T>(work: () => Promise<T>) => Promise<T>;
  done: () => void;
} {
  let total = 0;
  return {
    read: async (work) => {
      const began = performance.now();
      try {
        return await work();
      } finally {
        total += performance.now() - began;
      }
    },
    done: () => notePhase(request, "git", total),
  };
}

// GET /:owner/:name/tree/:ref[/*path]
export async function treePage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const git = gitClock(ctx.request);
  const fragmentOnly = ctx.url.searchParams.get("fragment") === "explorer";
  const all = ctx.url.searchParams.get("all") === "1";

  // An anonymous reader of a public repository is served the listing of the
  // commit the branch names, kept under that commit (`tree_cache.ts`), and
  // its links name the commit, so the edge may keep what they lead to.
  const anonymous = ctx.auth.user === undefined && repo.visibility === "public";
  const commit =
    anonymous && !fragmentOnly && isSafeRef(ref)
      ? await resolveCommit(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), ref)
      : undefined;
  // The whole page as it last went out to a stranger, encoded (`kept_page.ts`).
  const keptKey = commit === undefined ? undefined : keptPageKey(ctx, repo.id, commit);
  const finished = keptKey === undefined ? undefined : keptPage(keptKey);
  if (finished !== undefined) {
    git.done();
    return immutableWhenAddressed(ctx.request, true, repo, ref, finished);
  }
  const kept = (response: Response) => (keptKey === undefined ? response : keepPage(keptKey, response));
  if (commit !== undefined) {
    const hit = cachedTree(repo.id, commit, ref, path, all);
    if (hit !== undefined) {
      git.done();
      return immutableWhenAddressed(
        ctx.request,
        true,
        repo,
        ref,
        await kept(codePage(ctx, scope, { title: `${path || ref} · ${repo.name}`, ref, explorer: hit.explorer, content: hit.content })),
      );
    }
  }

  // A stranger's listing reads its folders and ref names through what other strangers' pages kept (#9514).
  const source = commit === undefined ? scope.source : withKeptFolders(repo.id, scope.source);
  const entries = await git.read(() => source.tree(commit ?? ref, path));
  if (!entries.ok) return notFoundPage(ctx);

  // The explorer's lazy expansion asks for exactly one directory.
  if (fragmentOnly) {
    git.done();
    return fragment(explorerFragment(scope.base, ref, path, entries.value), {
      request: ctx.request,
    });
  }

  const [refs, explorer] = await git.read(() =>
    Promise.all([
      commit === undefined ? refSetFrom(scope.source) : keptRefs(repo.id, () => refSetFrom(scope.source)),
      loadExplorer(source, ref, path, false),
    ]),
  );
  git.done();
  // `render` includes the README read: it is fetched while the page is built.
  const began = performance.now();
  const explorerHtml = explorerColumn(scope, explorer, {
    finder: true,
    actions: newFileAction(scope, ref, path),
  });
  const content = await renderCode(scope, {
    refs,
    ref,
    path,
    entries: entries.value,
    all,
    ...(commit === undefined ? {} : { linkRef: commit }),
  });
  if (commit !== undefined) keepTree(repo.id, commit, ref, path, all, { explorer: explorerHtml, content });
  const response = await kept(
    codePage(ctx, scope, {
      title: `${path || ref} · ${repo.name}`,
      ref,
      explorer: explorerHtml,
      content,
    }),
  );
  notePhase(ctx.request, "render", performance.now() - began);
  return immutableWhenAddressed(ctx.request, anonymous, repo, ref, response);
}

// GET /:owner/:name/blob/:ref/*path
export async function blobPage(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const scope = localScope(ctx, repo);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const git = gitClock(ctx.request);
  // A stranger's page at a full commit id is kept under that id (#9405): the
  // second read of it walks no git at all.
  const kept =
    ctx.auth.user === undefined && repo.visibility === "public" && FULL_OID.test(ref) && ctx.url.searchParams.get("fragment") !== "1";
  const view = blobView(ctx.url.searchParams.get("view"));
  const all = ctx.url.searchParams.get("all") === "1";
  const table = ctx.url.searchParams.get("table")?.slice(0, 256) ?? undefined;
  // The whole page as it last went out to a stranger, encoded (`kept_page.ts`).
  const keptKey = kept ? keptPageKey(ctx, repo.id) : undefined;
  const finished = keptKey === undefined ? undefined : keptPage(keptKey);
  if (finished !== undefined) {
    git.done();
    return immutableWhenAddressed(ctx.request, true, repo, ref, finished);
  }
  // A `?table=` that names nothing in the file is a stranger's string: its page is never kept.
  let keepable = true;
  const keepFinished = (response: Response) => (keptKey === undefined || !keepable ? response : keepPage(keptKey, response, true));
  if (kept) {
    const hit = cachedBlobPage(repo.id, ref, path, `${view}\0${table ?? ""}`, all);
    if (hit !== undefined) {
      git.done();
      return immutableWhenAddressed(
        ctx.request,
        true,
        repo,
        ref,
        await keepFinished(codePage(ctx, scope, {
          title: hit.title,
          ref,
          explorer: hit.explorer,
          content: hit.content,
          objectSrc: hit.objectSrc,
          ...(hit.font ? { fontSrc: true, extraJs: fontJs } : hit.csv ? { extraJs: csvJs } : {}),
        })),
      );
    }
  }
  const blob = await git.read(() => scope.source.blob(ref, path));
  if (!blob.ok) return notFoundPage(ctx);
  // A stranger's file page reads its folders and ref names through what other strangers' pages kept (#9514).
  const source = kept ? withKeptFolders(repo.id, scope.source) : scope.source;
  const refs = await git.read(() => (kept ? keptRefs(repo.id, () => refSetFrom(scope.source)) : refSetFrom(scope.source)));
  let highlightMs: number | undefined;
  const renderStart = performance.now();
  const shown = capped(blob.value, path);
  if (table !== undefined) keepable = shown.kind !== "too_large" && hasTable(shown.body, table);
  // A cold page for a stranger highlights and lays out its rows on a worker (#9630).
  let rows: CodeRows | undefined;
  if (kept && shown.kind === "text" && (view === "source" || !blobRenderer(scope, path, shown))) {
    const began = performance.now();
    rows = await rowsOffThread(shown.body, path, all ? MAX_RENDER_LINES : FIRST_LINES);
    if (rows !== undefined) notePhase(ctx.request, "highlight", performance.now() - began);
  }
  const pane = renderBlob(scope, {
    ...(rows !== undefined ? { rows } : {}),
    refs,
    ref,
    path,
    blob: shown,
    view,
    highlighted: (ms) => (highlightMs = (highlightMs ?? 0) + ms),
    all,
    ...(table !== undefined ? { table } : {}),
  });
  if (highlightMs !== undefined) notePhase(ctx.request, "highlight", highlightMs);
  const paneMs = performance.now() - renderStart - (highlightMs ?? 0);

  // The preview a script drops into the pane beside the explorer. Same
  // renderer, same markup — a preview and a real page load are the same file.
  if (ctx.url.searchParams.get("fragment") === "1") {
    git.done();
    notePhase(ctx.request, "render", paneMs);
    return fragment(pane, { request: ctx.request });
  }

  const explorer = await git.read(() =>
    loadExplorer(source, ref, path, true),
  );
  git.done();
  const filename = path.split("/").pop() ?? path;
  const pageStart = performance.now();
  const explorerHtml = explorerColumn(scope, explorer, {
    finder: true,
    actions: newFileAction(
      scope,
      ref,
      path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    ),
  });
  const objectSrc = drawsPdf(scope, path, shown, view);
  const font = drawsFont(scope, path, shown, view);
  if (kept && keepable)
    keepBlobPage(repo.id, ref, path, `${view}\0${table ?? ""}`, all, {
      title: `${filename} · ${repo.name}`,
      explorer: explorerHtml,
      content: pane,
      objectSrc,
      font,
      csv: isCsvPath(path),
    });
  const response = await keepFinished(codePage(ctx, scope, {
    title: `${filename} · ${repo.name}`,
    ref,
    explorer: explorerHtml,
    content: pane,
    objectSrc,
    ...(font ? { fontSrc: true, extraJs: fontJs } : isCsvPath(path) ? { extraJs: csvJs } : {}),
  }));
  notePhase(ctx.request, "render", paneMs + performance.now() - pageStart);
  return immutableWhenAddressed(ctx.request, ctx.auth.user === undefined, repo, ref, response);
}

/**
 * GET /:owner/:name/paths/:ref — every file path at a ref, as JSON, for the
 * fuzzy finder. It is the same read `RepoSource.paths` already bounds and
 * caches, behind the same `canRead` every other repo route asks: a repository
 * you cannot see does not have a path list either.
 */
export async function pathsJson(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFound();
  const scope = localScope(ctx, repo);
  const listed = await scope.source.paths(ctx.params.ref ?? "");
  if (!listed.ok) return notFound();
  return json(
    {
      ref: ctx.params.ref ?? "",
      paths: listed.value.paths,
      truncated: listed.value.truncated,
    },
    200,
    { "cache-control": "private, max-age=30" },
  );
}

/**
 * The page's own render ceiling, under the source's fetch ceiling. A body
 * over it is dropped and only its head kept, so a media kind is still drawn.
 */
export function capped(blob: Blob, path = ""): Blob {
  // A SQLite file is read whole, up to its own cap, because the database is opened from the bytes.
  if (blob.kind !== "too_large" && fileKind(path, blob.body.subarray(0, HEAD_BYTES)) === "sqlite" && blob.size <= RENDER_CAP.sqlite)
    return blob;
  return blob.kind !== "too_large" && blob.size > MAX_RENDER_BYTES
    ? { kind: "too_large", size: blob.size, head: blob.body.slice(0, HEAD_BYTES) }
    : blob;
}

/**
 * GET /:owner/:name/raw/:ref/*path — the bytes, nothing else. Served as plain
 * text (or an opaque stream for binary) with `nosniff` and a `sandbox` CSP, so
 * a file in a repository can never execute as a page on this origin.
 */
export async function rawBlob(ctx: Ctx): Promise<Response> {
  // `session` first, so it is named on every answer, 404s included. There is
  // no `stream` phase: the body is bytes already in memory, nothing to time.
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const ref = ctx.params.ref ?? "";
  const path = ctx.params.path ?? "";
  if (!isSafeRef(ref) || !isSafeTreePath(path)) return notFoundPage(ctx);

  const dir = repoDir(ctx.app.reposRoot, repo.ownerName, repo.name);
  // At a full commit id the bytes never change: a small file is kept (#9405).
  const pinned = FULL_OID.test(ref);
  // A held read names no `git` phase: git did not run. A read that throws
  // still names the time it took.
  const held = pinned ? cachedRaw(repo.id, ref, path) : undefined;
  let blob = held;
  if (blob === undefined) {
    const gitAt = performance.now();
    try {
      blob = await blobForRender(dir, ref, path, 25_000_000);
    } finally {
      notePhase(ctx.request, "git", performance.now() - gitAt);
    }
  }
  if (blob.kind === "missing" || blob.kind === "too_large")
    return notFoundPage(ctx);
  if (pinned && held === undefined) keepRaw(repo.id, ref, path, blob);
  return rawResponse(blob, {
    oid: blob.oid,
    immutable: FULL_OID.test(ref),
    public: mayShare(ctx.request, ctx.auth.user === undefined, repo, ref),
    request: ctx.request,
  });
}

const FULL_OID = /^[0-9a-f]{40}$/;
