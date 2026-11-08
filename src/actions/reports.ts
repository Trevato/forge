/**
 * Reports from outside (`core/reports.ts`): anyone files one on a public
 * repository; a person who writes it reads, accepts or dismisses.
 *
 * The door is open to strangers, so its limits are mechanical:
 *
 * - **Public only.** A private repository answers `not_found`, exactly as a
 *   missing one, whoever asks.
 * - **Limited three ways.** Per source, per repository, and for the whole
 *   forge, each a sliding minute; and a repository holds at most
 *   `WAITING_MAX` waiting reports. A source is a forwarded address — a
 *   claim — so the other two caps are what hold when it lies.
 * - **No text in the outbox.** The event says a report arrived, by id, to
 *   the repository's admins; webhooks, streams and the crew never carry the
 *   words.
 * - **A person decides.** Reading, accepting and dismissing need a person
 *   who writes the repository; an agent is refused even when it is on the
 *   crew, so a stranger's text reaches an agent only after a person has
 *   made it their own issue.
 * - **It stays marked.** The issue's title opens with `OUTSIDE_TITLE` and
 *   it carries the label `OUTSIDE_LABEL`. The person may change the title's
 *   words before it opens; the marker is not theirs to remove, and the
 *   crew's brief says whose words an issue so marked holds.
 */
import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import {
  OUTSIDE_COLOR,
  OUTSIDE_LABEL,
  WAITING_MAX,
  cleanReport,
  countWaiting,
  decideReport,
  filerWords,
  getReport,
  insertReport,
  listWaiting,
  noteIssue,
  outsideTitle,
  undecideReport,
  type Report,
  type ReportError,
  type ReportInput,
} from "../core/reports.ts";
import { createLabel, getLabel, type Issue } from "../core/issues.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { defect } from "../kernel/error.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { openIssueThrough, setIssueLabels } from "./issues.ts";

const PER_SOURCE = 3;
const PER_REPO = 20;
const PER_FORGE = 60;

interface Limits {
  readonly source: RateLimiter;
  readonly repo: RateLimiter;
  readonly forge: RateLimiter;
}

const limiter = (perMinute: number) =>
  new RateLimiter({ perMinute, adminPerMinute: perMinute, enabled: true });

/** One set per forge, so a test's forge never throttles another's. */
const limits = new WeakMap<App, Limits>();
function limitsOf(app: App): Limits {
  let found = limits.get(app);
  if (found === undefined) {
    found = {
      source: limiter(PER_SOURCE),
      repo: limiter(PER_REPO),
      forge: limiter(PER_FORGE),
    };
    limits.set(app, found);
  }
  return found;
}

export type FileRefusal =
  | { readonly error: "not_found" | ReportError | "queue_full" }
  | { readonly error: "rate_limited"; readonly retryAfter: number };

/**
 * File a report on a public repository; `source` keys the per-source limit.
 * `filer` is the account a token or session proved, when one did: the
 * report carries it as the filer's identity, and any `agent` name given
 * beside it is dropped. Without one, a given name is kept as a claim.
 */
export function fileReport(
  app: App,
  repo: Repo,
  input: ReportInput,
  source: string,
  filer?: User,
): Result<Report, FileRefusal> {
  if (!canRead(app.db, repo, undefined)) return err({ error: "not_found" });
  const clean = cleanReport(input);
  if (!clean.ok) return err({ error: clean.error });
  const { forge, repo: perRepo, source: perSource } = limitsOf(app);
  for (const verdict of [
    () => forge.take("forge", "ro"),
    () => perRepo.take(repo.id, "ro"),
    () => perSource.take(source, "ro"),
  ]) {
    const v = verdict();
    if (!v.allowed)
      return err({ error: "rate_limited", retryAfter: v.retryAfter });
  }
  if (countWaiting(app.db, repo.id) >= WAITING_MAX)
    return err({ error: "queue_full" });
  const report = insertReport(
    app.db,
    repo.id,
    clean.value,
    filer?.kind === "org" ? null : (filer?.id ?? null),
  );
  app.bus.append({
    kind: "report.received",
    repoId: repo.id,
    payload: { id: report.id },
  });
  return ok(report);
}

type DeciderError = "not_found" | "unauthorized" | "forbidden";

/** A person — never an agent — who writes the repository. */
function requireDecider(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<User, DeciderError> {
  if (!canRead(app.db, repo, actor)) return err("not_found");
  if (!actor) return err("unauthorized");
  if (actor.kind !== "user" || !canWrite(app.db, repo, actor))
    return err("forbidden");
  return ok(actor);
}

export function waitingReports(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<Report[], DeciderError> {
  const decider = requireDecider(app, actor, repo);
  if (!decider.ok) return decider;
  return ok(listWaiting(app.db, repo.id));
}

/** A report as the API and the MCP answer it. */
export interface ReportView {
  readonly id: string;
  readonly repoId: string;
  readonly title: string;
  readonly body: string;
  readonly page: string | null;
  readonly state: Report["state"];
  readonly createdAt: string;
  readonly from: "outside";
  readonly filedBy: Report["filedBy"];
  /** Set unless a proven filer writes the repository: the words are a stranger's. */
  readonly untrusted?: true;
}

/**
 * Reports as the API and the MCP answer them. Whether a filer writes the
 * repository is asked once per distinct filer, not once per report.
 */
export function reportViews(
  app: App,
  repo: Repo,
  reports: readonly Report[],
): ReportView[] {
  const writes = new Map<string, boolean>();
  const writer = (filerId: string): boolean => {
    let known = writes.get(filerId);
    if (known === undefined) {
      const filer = getUserById(app.db, filerId);
      known = filer !== undefined && canWrite(app.db, repo, filer);
      writes.set(filerId, known);
    }
    return known;
  };
  return reports.map((r) =>
    reportView(r, r.filerId !== null && writer(r.filerId)),
  );
}

function reportView(r: Report, trusted: boolean): ReportView {
  return {
    id: r.id,
    repoId: r.repoId,
    title: r.title,
    body: r.body,
    page: r.page,
    state: r.state,
    createdAt: r.createdAt,
    from: "outside",
    filedBy: r.filedBy,
    ...(trusted ? {} : { untrusted: true as const }),
  };
}

/** How many reports wait, for a surface that shows a count; 0 to anyone else. */
export function waitingCount(
  app: App,
  actor: User | undefined,
  repo: Repo,
): number {
  return requireDecider(app, actor, repo).ok
    ? countWaiting(app.db, repo.id)
    : 0;
}

/** A fence longer than any run of backticks in the text, so it cannot close early. */
function fenced(text: string): string {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The issue an accepted report becomes: the person's own, saying where the
 * words came from, with everything the stranger chose — the page it was
 * sent from and the words — inside one fence, so it shows as plain text and
 * no link or image of theirs renders live.
 */
export function acceptedBody(report: Report, by: User): string {
  const quoted = [
    ...(report.page === null ? [] : [`Sent from: ${report.page}`, ""]),
    report.body,
  ]
    .join("\n")
    .trim();
  const from =
    report.filedBy.how === "anonymous"
      ? "without an account"
      : `by ${filerWords(report.filedBy)}`;
  const lines = [
    `Reported from outside, ${from}, ${report.createdAt.slice(0, 10)}. ` +
      `Accepted by @${by.username}; what is below is the reporter's, unchecked.`,
  ];
  if (quoted !== "") lines.push("", fenced(quoted));
  return lines.join("\n");
}

export type DecideError = DeciderError | "decided";

/**
 * Accept a report as an issue. `title` is the accepting person's wording,
 * the report's own when they leave it; either way it opens behind the
 * marker. A title that cannot be used refuses before anything is decided,
 * so the report still waits.
 */
export async function acceptReport(
  app: App,
  actor: User | undefined,
  repo: Repo,
  reportId: string,
  title?: string,
): Promise<Result<Issue, DecideError | string>> {
  const decider = requireDecider(app, actor, repo);
  if (!decider.ok) return decider;
  const report = getReport(app.db, repo.id, reportId);
  if (report === undefined) return err("not_found");
  const named = outsideTitle(title ?? report.title);
  if (!named.ok) return named;
  if (
    !decideReport(app.db, report.id, {
      state: "accepted",
      by: decider.value.id,
    })
  )
    return err("decided");
  const opened = await openIssueThrough(app, decider.value, repo, {
    title: named.value,
    body: acceptedBody(report, decider.value),
    labels: [OUTSIDE_LABEL],
  });
  if (!opened.ok) {
    undecideReport(app.db, report.id);
    return err(opened.error);
  }
  // The issue exists. The report takes its number and the outbox hears of
  // it now, before anything else can fail: an accepted report with no issue
  // to show for it could be neither found nor accepted again.
  noteIssue(app.db, report.id, opened.value.number);
  app.bus.append({
    kind: "report.accepted",
    repoId: repo.id,
    actorId: decider.value.id,
    payload: { id: report.id, number: opened.value.number },
  });
  // On a mirror the label went up with the issue and the origin's answer is
  // what stands. Here the forge keeps the label itself, made on first use.
  if (!isMirror(app, repo)) {
    if (getLabel(app.db, repo.id, OUTSIDE_LABEL) === undefined)
      createLabel(app.db, repo.id, OUTSIDE_LABEL, OUTSIDE_COLOR);
    const labelled = setIssueLabels(app, decider.value, repo, opened.value, [
      OUTSIDE_LABEL,
    ]);
    if (!labelled.ok)
      defect(
        "report.unlabelled",
        `issue #${opened.value.number} could not take the ${OUTSIDE_LABEL} label: ${labelled.error}`,
      );
  }
  return ok(opened.value);
}

export function dismissReport(
  app: App,
  actor: User | undefined,
  repo: Repo,
  reportId: string,
): Result<true, DecideError> {
  const decider = requireDecider(app, actor, repo);
  if (!decider.ok) return decider;
  const report = getReport(app.db, repo.id, reportId);
  if (report === undefined) return err("not_found");
  if (
    !decideReport(app.db, report.id, {
      state: "dismissed",
      by: decider.value.id,
    })
  )
    return err("decided");
  app.bus.append({
    kind: "report.dismissed",
    repoId: repo.id,
    actorId: decider.value.id,
    payload: { id: report.id },
  });
  return ok(true);
}
