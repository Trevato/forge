/**
 * The workspace: a repository as an editor opens one.
 *
 * There used to be four screens here — a repo home with a README card, a
 * directory listing, a blob page, and a modal editor you pushed on top of all
 * of them — and moving between them was a stack of pushes and escapes. That is
 * the file system's model, not a worker's. Somebody who came to *do* something
 * opens a repository, reads a file, opens a second one beside it, changes both
 * and proposes them. So this is one screen for the whole of that:
 *
 *     explorer │ tabs │ a file, viewed or edited │ one commit
 *
 * Four rules shape it, and they are the ones the old arrangement broke.
 *
 * - **Moving the cursor reads nothing.** The explorer is a cursor over names.
 *   `enter` opens a tab; `j` does not. The preview-on-hover it replaces was
 *   a read per keystroke, a debounce, a token, and a file you could not scroll
 *   because the selector was in the other pane.
 * - **A tab owns its buffer.** Its scroll, its search, its undo history and
 *   its edits all live in the tab, so switching tabs — or leaving for the
 *   issue list and coming back — loses nothing. The screen stays on the stack
 *   while something is pushed over it, which is what makes that free.
 * - **Editing is a mode, not a screen.** `e` turns the tab into the buffer
 *   from `ui/editor.ts` in place; `esc` returns to reading with the edits
 *   still there. Nothing is "saved" until a commit, and a modified tab says so
 *   with a dot everywhere it appears.
 * - **One commit for the whole change.** Every modified tab and every pending
 *   deletion goes into a single `editFiles` call — the action's own shape —
 *   so a branch with no commit, or a commit with no pull, cannot be invented
 *   here. A refused commit keeps every buffer.
 *
 * Nothing in this file writes a byte. `editFiles` and `createBranch` are the
 * only paths to the object store; they authorize, they refuse a protected
 * default, and on a mirror they ask the origin first.
 */

import { editFiles } from "../../actions/contents.ts";
import { proposeEdit, proposeEditText } from "../../actions/propose_edit.ts";
import { schemaRefusal } from "../../web/render/json-schema.ts";
import { err, ok } from "../../kernel/result.ts";
import { createBranch } from "../../actions/branches.ts";
import { NAME_THE_BRANCH } from "../../actions/branch_words.ts";
import { pinRepo, syncRepoNow, unpinRepo } from "../../actions/origins.ts";
import { isPinned } from "../../core/pins.ts";
import { creditOf, creditText } from "../../core/credit.ts";
import { setDecisionsBy } from "../../actions/repos.ts";
import { stopMirroring } from "../../actions/mirror_target.ts";
import { getMirrorTarget, mirrorLine } from "../../core/migrate_mirror.ts";
import { canAdmin, canWrite, DECISIONS_BY, getRepoById, type Repo } from "../../core/repos.ts";
import type { TreeEntry } from "../../git/read.ts";
import { parseUnifiedDiff, type Diff } from "../../git/diff.ts";
import { renderDiff as renderPatch } from "../ui/diff.ts";
import { fileKind, isEnvExample, kindByName, NO_BYTES } from "../../web/render/kinds.ts";
import { downloadHref } from "../../web/pages/media.ts";
import { isModelPath, modelFacts } from "../../web/render/model-facts.ts";
import type { RepoFacts, RepoSource } from "../../view/source.ts";
import { detectLanguage, highlightLines } from "../../web/highlight.ts";
import { MAX_COLUMNS, parseCsv, type Table } from "../../text/csv.ts";
import { parseGeoJson, propertyRows } from "../../web/render/geojson.ts";
import { gcodeFacts, parseGcode } from "../../web/render/gcode.ts";
import { parseHar, ROW_CAP as HAR_ROW_CAP, duration as harDuration } from "../../web/render/har.ts";
import { gpxFacts, parseGpx } from "../../web/render/gpx.ts";
import { CASE_CAP, parseJunit } from "../../web/render/junit.ts";
import { parseOpenApi } from "../../web/render/openapi.ts";
import { parseDockerfile } from "../../web/render/dockerfile.ts";
import { parseWorkflow } from "../../web/render/workflow.ts";
import { parseGraphql } from "../../web/render/graphql.ts";
import { parseSql } from "../../web/render/sql.ts";
import { RESULT_CAP, parseSarif } from "../../web/render/sarif.ts";
import { RECORD_CAP, parseLcov, worstFirst, type Ratio } from "../../web/render/lcov.ts";
import { EVENT_CAP, parseIcs } from "../../web/render/ics.ts";
import { fileSize } from "../../web/ui.ts";
import { parseEml } from "../../web/render/eml-parse.ts";
import { parsePackage, ROW_CAP as PKG_ROW_CAP } from "../../web/render/package-json.ts";
import { parseEnv, ROW_CAP as ENV_ROW_CAP } from "../../web/render/env.ts";
import { CARD_CAP, parseVcf } from "../../web/render/vcf-parse.ts";
import { CUE_CAP, parseSubtitles } from "../../web/render/subtitles.ts";
import { isJsonlPath, kindView, type KindLines } from "./workspace_kinds.ts";
import { layoutTable, type Grid } from "../ui/grid.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { stripAnsi } from "../term/ansi.ts";
import { binding, type Binding } from "../app/keys.ts";
import type { KeyEvent } from "../term/input.ts";
import {
  G,
  type Rect,
  type Screen as Surface,
  type Span,
} from "../term/screen.ts";
import { BOLD, STRIKE, UNDERLINE, style } from "../term/style.ts";
import {
  clusters,
  displayWidth,
  expandTabs,
  pad,
  truncate,
} from "../term/width.ts";
import { Editor } from "../ui/editor.ts";
import { fileIcon, looksLikeImage, type IconSet } from "../ui/icons.ts";
import {
  drawImage,
  humanBytes,
  prepareImage,
  type TerminalImage,
} from "../ui/image.ts";
import { fill, len, split } from "../ui/layout.ts";
import { renderMarkdown, type Line } from "../ui/markdown.ts";
import { archiveNote } from "../ui/archive-note.ts";
import { mediaNote } from "../ui/media-note.ts";
import { tokColor, type Tokens } from "../ui/theme.ts";
import { card, emptyState, input, scrollbar } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import { aboutScreen } from "./about.ts";
import {
  commitScreen,
  editErrorText,
  suggestBranch,
  type CommitFile,
} from "./commit.ts";
import {
  contributeErrorText,
  forkAtOrigin,
  importedInto,
  originTarget,
  propose,
  proposeTarget,
  proposingStatus,
  type OriginTarget,
} from "./contribute.ts";
import { canSeeAnswers } from "../../web/studio/answers.ts";
import { answersScreen } from "./answers.ts";
import { commitsScreen } from "./commits.ts";
import { deploysScreen } from "./deploys.ts";
import { hooksCommands } from "./hooks.ts";
import { runsScreen } from "./runs.ts";
import {
  Filter,
  ListState,
  Scroll,
  confirmScreen,
  drawFacts,
  drawLines,
  errorText,
  hitList,
  live as liveUpdates,
  openLink,
  plural,
  promptScreen,
  runAsync,
  slug,
  openOnWeb,
} from "./common.ts";
import { noteCommands } from "./notes.ts";
import { reportCommands } from "./report.ts";
import { reportsCommands } from "./reports.ts";
import { tellCommands } from "./tell.ts";
import { workingCommands } from "./working.ts";
import { forgeItCommands } from "./forge_it.ts";
import { makeItYoursScreen, yoursCommands } from "./yours.ts";
import { deleteRepoCommands } from "./deleterepo.ts";
import { transferRepoCommands } from "./transferrepo.ts";
import { grantsCommands } from "./grants.ts";
import { visionCommands } from "./vision.ts";
import { buildsCommands } from "./builds.ts";
import { displayCommands } from "./display.ts";
import { iterationsCommands } from "./iterations.ts";
import { labelsCommands } from "./labels.ts";
import { appEnvCommands } from "./appenv.ts";
import { variantsCommands } from "./variants.ts";
import { autonomyCommands } from "./autonomy.ts";
import { trafficCommands } from "./trafficview.ts";
import { chaptersCommands } from "./chapters.ts";
import { schedulesCommands } from "./schedules.ts";
import { dataImportCommands } from "./dataimport.ts";
import { jobsCommands } from "./jobs.ts";
import { queueCommands } from "./queuegrowth.ts";
import { blockedCommands } from "./blocked.ts";
import { statementCommands } from "./statement.ts";
import { moneyCommands } from "./money.ts";
import { adapterCommands } from "./adapter.ts";
import { atlasCommands } from "./atlas.ts";
import { externalEditor, editorHint, hasExternalEditor } from "./external.ts";
import { finderScreen } from "./finder.ts";
import { issuesScreen } from "./issues.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { forkScreen } from "./newrepo.ts";
import { pullScreen } from "./pull.ts";
import { forksScreen } from "./forks.ts";
import { branchesScreen } from "./refs.ts";
import { wavesScreen } from "./waves.ts";
import {
  knownDefaultRef,
  liveOrigin,
  local,
  localRepo,
  originFileUrl,
  originUrl,
  otherSide,
  otherSideLabel,
  sourceName,
  whereLayout,
  whereRows,
  whereSpans,
  whereStrip,
} from "./where.ts";

/**
 * The mark a rendered markdown tab wears — `README.md ¶`. From the safe set
 * in `term/screen.ts` (documented in `docs/DESIGN.md`): it is the one glyph
 * in that set that already means "formatted prose", and `v` takes it off.
 */
const PROSE_MARK = G.para;

/** Blobs kept per workspace; a session revisits the same handful. */
const CACHE_LIMIT = 24;
/** The explorer's column, when there is room for two panes. */
const EXPLORER_MIN = 22;
const EXPLORER_MAX = 38;

function formatSize(bytes: number): string {
  if (bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} K`;
  return `${(bytes / 1024 / 1024).toFixed(1)} M`;
}

// ---- the explorer's model ----

interface Node {
  readonly path: string;
  readonly name: string;
  readonly type: "tree" | "blob";
  readonly size: number;
  readonly depth: number;
  expanded: boolean;
  loading: boolean;
  /** Null until the directory has been listed once. */
  children: Node[] | null;
}

function nodeOf(entry: TreeEntry, parent: string, depth: number): Node {
  return {
    path: parent === "" ? entry.name : `${parent}/${entry.name}`,
    name: entry.name,
    type: entry.type === "tree" ? "tree" : "blob",
    size: entry.size,
    depth,
    expanded: false,
    loading: false,
    children: null,
  };
}

/** Depth-first walk of what is currently expanded — the rows on screen. */
function flatten(nodes: readonly Node[], out: Node[] = []): Node[] {
  for (const node of nodes) {
    out.push(node);
    if (node.expanded && node.children !== null) flatten(node.children, out);
  }
  return out;
}

function findNode(nodes: readonly Node[], path: string): Node | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (path.startsWith(`${node.path}/`) && node.children !== null) {
      const hit = findNode(node.children, path);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The file a repository opens on: its README, else the first file there. */
function landing(nodes: readonly Node[]): Node | undefined {
  const readme = nodes.find(
    (n) => n.type === "blob" && /^readme(\.|$)/i.test(n.name),
  );
  return readme ?? nodes.find((n) => n.type === "blob");
}

// ---- a file, as a tab ----

/**
 * Styled rows plus the plain text behind them. The gutter is *not* in the
 * spans: the pane draws line numbers itself, so they stay pinned while the
 * code scrolls sideways under them.
 */
function isLogPath(path: string): boolean {
  return /\.(log|ansi)$/i.test(path);
}

export function buildLines(
  text: string,
  path: string,
  c: Tokens,
): { plain: string[]; lines: Span[][] } {
  // A terminal log carries escapes; the viewer shows its text, never drives
  // the terminal or prints "[31m" as if it were the log.
  const clean = isLogPath(path) && text.includes("\x1b") ? stripAnsi(text) : text;
  const body = clean.replace(/\n$/, "");
  const plain = body.split("\n").map((l) => expandTabs(l));
  // The first line is handed to the detector too: a `#!/usr/bin/env python3`
  // with no extension, a `.zshrc`, a vim modeline. The name is the strong
  // signal and the line is the fallback, which is the detector's own order.
  const language = detectLanguage(path, plain[0] ?? "");
  const lines = highlightLines(plain.join("\n"), language).map(
    (tokens): Span[] =>
      tokens.map((t) => ({
        text: t.text,
        style: style(tokColor(c, t), c.bg),
      })),
  );
  return { plain, lines };
}

type TabMode = "view" | "edit";
type FindMode = "off" | "find" | "replace";
/** What a path is, as far as the file pane is concerned. */
type TabKind = "image" | "markdown" | "patch" | "code";

/** `.csv` and `.tsv`: files that read as a table. */
function isTablePath(path: string): boolean {
  return /\.[ct]sv$/i.test(path);
}

/** `.srt` and `.vtt`: a transcript, drawn as the same two-column table. */
function isSubtitlePath(path: string): boolean {
  return /\.(srt|vtt)$/i.test(path);
}

/** The cues of a subtitle file as a table: start time, text. Shares the web's parser. */
function subtitleTable(source: string): { table: Table; unread: number } {
  const { cues, failures } = parseSubtitles(source);
  const shown = cues.slice(0, CUE_CAP);
  return {
    unread: failures.length,
    table: {
      header: ["Start", "Text"],
      rows: shown.map((c) => [c.start, c.text]),
      more: cues.length - shown.length,
      delimiter: ",",
      columns: 2,
    },
  };
}

/** `.ics`: a calendar, drawn as a table of its events. */
function isIcsPath(path: string): boolean {
  return /\.ics$/i.test(path);
}

/** The events of a calendar as a table; null when the file is not a calendar. Shares the web's parser. */
function icsTable(source: string): Table | null {
  const cal = parseIcs(source);
  if ("error" in cal) return null;
  const shown = cal.events.slice(0, EVENT_CAP);
  return {
    header: ["Start", "End", "Summary", "Location"],
    rows: shown.map((e) => [e.start, e.end, e.summary, e.location]),
    more: cal.events.length - shown.length,
    delimiter: ",",
    columns: 4,
  };
}

/** `.vcf` and `.vcard`: contacts, drawn as a table of people. */
function isVcfPath(path: string): boolean {
  return /\.(vcf|vcard)$/i.test(path);
}

/** The cards of a contacts file as a table; null when the file is not one. Shares the web's parser. */
function vcfTable(source: string): Table | null {
  const parsed = parseVcf(source);
  if ("error" in parsed || parsed.total === 0) return null;
  const shown = parsed.cards.slice(0, CARD_CAP);
  return {
    header: ["Name", "Organisation", "Email", "Phone"],
    rows: shown.map((c) => [c.name, c.org, c.emails.join(", "), c.phones.join(", ")]),
    more: parsed.total - shown.length,
    delimiter: ",",
    columns: 4,
  };
}

/** The variables of a `.env.example` as a table; null when it holds none. Shares the web's parser. */
function envTable(source: string): Table | null {
  const doc = parseEnv(source);
  if (doc.total === 0) return null;
  const dash = (v: string): string => (v === "" ? "—" : v);
  const rows: string[][] = [];
  let last = "";
  for (const r of doc.rows.slice(0, ENV_ROW_CAP)) {
    if (r.group !== "" && r.group !== last) rows.push([`# ${r.group}`, "", ""]);
    last = r.group;
    rows.push([r.name, dash(r.value), dash(r.comment)]);
  }
  return { header: ["Name", "Example", "Comment"], rows, more: doc.total - doc.rows.length, delimiter: ",", columns: 3 };
}

/** A `package.json` as Section/Name/Value rows; null when it is not a JSON object. Shares the web's parser. */
function packageTable(source: string): Table | null {
  const doc = parsePackage(source);
  if (doc === undefined) return null;
  const rows: string[][] = [];
  if (doc.name !== "") rows.push(["package", doc.name, doc.version]);
  if (doc.facts.length > 0) rows.push(["facts", doc.facts.join(" · "), ""]);
  let more = 0;
  for (const s of doc.sections) {
    for (const [k, v] of s.rows.slice(0, PKG_ROW_CAP)) rows.push([s.title, k, v]);
    more += s.total - s.rows.length;
  }
  if (rows.length === 0) return null;
  return { header: ["Section", "Name", "Value"], rows, more, delimiter: ",", columns: 3 };
}

/** `.eml`: a message, drawn as rows of its headers, body and attachments. */
function isEmlPath(path: string): boolean {
  return /\.eml$/i.test(path);
}

const EML_BODY_LINES = 200;

/** The message as Field/Value rows; null when the file is not one. Shares the web's parser. */
function emlTable(source: Uint8Array): Table | null {
  const m = parseEml(source);
  if ("error" in m) return null;
  const rows: string[][] = m.headers.map(([k, v]) => [k, v]);
  if (m.fromHtml) rows.push(["Note", "only an HTML part; tags stripped"]);
  const lines = m.body.split("\n");
  for (const line of lines.slice(0, EML_BODY_LINES)) rows.push(["", line]);
  if (lines.length > EML_BODY_LINES) rows.push(["Note", `body cut: ${lines.length - EML_BODY_LINES} more lines`]);
  for (const a of m.attachments) rows.push(["Attachment", `${a.name} · ${a.type} · ${fileSize(a.size)}`]);
  return { header: ["Field", "Value"], rows, more: 0, delimiter: ",", columns: 2 };
}

/** `.gpx`: a GPS track, drawn as a table of its facts (track, distance, climb, points). */
function isGpxPath(path: string): boolean {
  return /\.gpx$/i.test(path);
}

/** The facts of a track as a table; null when the file is not a track. Shares the web's parser. */
function gpxTable(source: string, path: string): Table | null {
  const parsed = parseGpx(source);
  if (parsed === undefined) return null;
  const rows = gpxFacts(parsed, path);
  return { header: ["Fact", "Value"], rows, more: 0, delimiter: ",", columns: 2 };
}

/** `.har`: a browser's captured session, drawn as a table of its requests. */
function isHarPath(path: string): boolean {
  return /\.har$/i.test(path);
}

/** The requests of a HAR as a table; null when the file is not one. Shares the web's parser and row cap. */
export function harTable(source: string): Table | null {
  const parsed = parseHar(source);
  if ("error" in parsed || parsed.entries.length === 0) return null;
  const shown = parsed.entries.slice(0, HAR_ROW_CAP);
  return {
    header: ["Method", "Status", "URL", "Size", "Time"],
    rows: shown.map((e) => [
      e.method,
      e.status === 0 ? "-" : String(e.status),
      e.url,
      e.bytes === undefined ? "-" : fileSize(e.bytes),
      harDuration(e.ms),
    ]),
    more: parsed.entries.length - shown.length,
    delimiter: ",",
    columns: 5,
  };
}

/** `.sarif`: a scanner's findings, drawn as a table of level, rule, location and message. */
function isSarifPath(path: string): boolean {
  return /\.sarif$/i.test(path);
}

/** The findings of a SARIF file as a table, tool by tool; the reason, as the page words it, when it is not SARIF. Shares the web's parser. */
function sarifTable(source: string): Table | string {
  const parsed = parseSarif(source);
  if ("error" in parsed) return `not drawn as findings: ${parsed.error}`;
  const all = parsed.runs.flatMap((r) =>
    r.results.map((f) => [f.level, f.rule, f.file === "" ? "-" : f.line > 0 ? `${f.file}:${f.line}` : f.file, f.message.replace(/\s+/g, " "), r.tool]),
  );
  const rows = all.slice(0, RESULT_CAP);
  return { header: ["Level", "Rule", "Location", "Message", "Tool"], rows, more: all.length - rows.length, delimiter: ",", columns: 5 };
}

/** `lcov.info` / `.lcov`: a coverage tracefile, drawn as a table per source file, worst line coverage first. */
function isLcovPath(path: string): boolean {
  return kindByName(path) === "lcov";
}

/** The coverage of an lcov file as a table; the reason, as the page words it, when it is not lcov. Shares the web's parser. */
function lcovTable(source: string): Table | string {
  const parsed = parseLcov(source);
  if ("error" in parsed) return `not drawn as coverage: ${parsed.error}`;
  const pct = (r: Ratio | undefined): string => (r === undefined || r.found === 0 ? "-" : `${r.hit}/${r.found} ${(Math.floor((r.hit / r.found) * 1000) / 10).toFixed(1)}%`);
  const sorted = worstFirst(parsed.records);
  const rows = sorted.slice(0, RECORD_CAP).map((r) => [r.file, pct(r.lines), pct(r.functions), pct(r.branches)]);
  return { header: ["File", "Lines", "Functions", "Branches"], rows, more: sorted.length - rows.length, delimiter: ",", columns: 4 };
}

/** An OpenAPI document by file name; whether its content is one is `openapiTable`'s to say. */
function isOpenApiPath(path: string): boolean {
  return kindByName(path) === "openapi";
}

/**
 * The operations of an OpenAPI document as a table, tag by tag; null when the file is not one,
 * the reason when it is but cannot be drawn. Shares the web's parser.
 */
function openapiTable(text: string, path: string): Table | string | null {
  const parsed = parseOpenApi(text, path);
  if (parsed === "not") return null;
  if ("error" in parsed) return `not drawn as an API: ${parsed.error}`;
  const rows = parsed.groups.flatMap((g) => g.ops.map((o) => [g.tag === "" ? "-" : g.tag, o.method, o.path, o.deprecated ? `${o.summary} (deprecated)`.trim() : o.summary]));
  return { header: ["Tag", "Method", "Path", "Summary"], rows, more: parsed.more, delimiter: ",", columns: 4 };
}

/** A Dockerfile by file name. */
function isDockerfilePath(path: string): boolean {
  return kindByName(path) === "dockerfile";
}

/**
 * A Dockerfile as a table: per stage, its ports and ENV names, then one row per instruction;
 * the web's reason when it is not drawn. Shares the web's parser.
 */
function dockerfileTable(source: string): Table | string {
  const parsed = parseDockerfile(source);
  if ("error" in parsed) return `not drawn as a build: ${parsed.error}`;
  const rows: string[][] = [];
  for (const s of parsed.stages) {
    const title = s.image === "" ? "(before the first stage)" : `${s.image}${s.name === "" ? "" : ` as ${s.name}`}`;
    rows.push([title, "FROM", s.image]);
    if (s.ports.length > 0) rows.push([title, "EXPOSE", s.ports.join(" ")]);
    if (s.env.length > 0) rows.push([title, "ENV", s.env.join(" ")]);
    for (const r of s.rows) rows.push([title, r.keyword, r.args.replace(/\s+/g, " ")]);
  }
  return { header: ["Stage", "Instruction", "Arguments"], rows, more: parsed.total - parsed.shown, delimiter: ",", columns: 3 };
}

/** A GitHub Actions workflow by file name. */
function isWorkflowPath(path: string): boolean {
  return kindByName(path) === "workflow";
}

/**
 * A workflow as a table: the triggers, then per job its runner, needs and matrix, then one row
 * per step; the web's reason when it is not drawn. Shares the web's parser.
 */
function workflowTable(source: string): Table | string {
  const parsed = parseWorkflow(source);
  if ("error" in parsed) return `not drawn as a workflow: ${parsed.error}`;
  const rows: string[][] = [["-", "on", parsed.triggers.join(" ")]];
  let more = parsed.jobsTotal - parsed.jobs.length;
  for (const j of parsed.jobs) {
    if (j.runsOn !== "") rows.push([j.id, "runs-on", j.runsOn]);
    if (j.needs.length > 0) rows.push([j.id, "needs", j.needs.join(" ")]);
    if (j.matrix.length > 0) rows.push([j.id, "matrix", j.matrix.join("; ")]);
    for (const s of j.steps) rows.push([j.id, s.kind === "" ? "step" : s.kind, [s.name, s.does].filter((t) => t !== "").join(": ").replace(/\s+/g, " ")]);
    more += j.stepsTotal - j.steps.length;
  }
  return { header: ["Job", "Kind", "Value"], rows, more, delimiter: ",", columns: 3 };
}

/** A `.sql` file by name. */
function isSqlPath(path: string): boolean {
  return kindByName(path) === "sql";
}

/** A SQL file as a table: a row per column of each CREATE TABLE, one row per other statement; the reason when it is not drawn. Shares the web's parser. */
function sqlTable(source: string): Table | string {
  const doc = parseSql(source);
  if (doc === null) return "not drawn as a schema: this file holds no SQL statements to draw";
  const dash = (v: string): string => (v === "" ? "-" : v);
  const rows = doc.statements.flatMap((s) =>
    s.kind === "other"
      ? [["-", s.line, "-", "-", "-", "-"]]
      : s.columns.map((c) => [s.name, c.name, dash(c.type), c.notNull ? "NOT NULL" : "-", c.primaryKey ? "PRIMARY KEY" : "-", dash(c.default)]),
  );
  return { header: ["Table", "Column", "Type", "Null", "Key", "Default"], rows, more: doc.total - doc.statements.length, delimiter: ",", columns: 6 };
}

/** A `.graphql` or `.gql` file by name. */
function isGraphqlPath(path: string): boolean {
  return kindByName(path) === "graphql";
}

/**
 * A GraphQL schema as a table: a row per field or enum value of each block (roots first), one row
 * per other definition; the reason when it is not drawn. Shares the web's parser.
 */
function graphqlTable(source: string): Table | string {
  const doc = parseGraphql(source);
  if (doc === null) return "not drawn as a schema: this file holds no type, input, interface or enum to draw";
  const dash = (v: string): string => (v === "" ? "-" : v);
  const rows = doc.blocks.flatMap((b) =>
    b.kind === "other"
      ? [["-", b.text, "-", "-", "-"]]
      : [
          ...(b.header === "" ? [] : [[`${b.extend ? "extend " : ""}${b.kind} ${b.name}`, "-", "-", "-", b.header]]),
          ...b.fields.map((f) => [`${b.extend ? "extend " : ""}${b.kind} ${b.name}`, f.name, dash(f.args), dash(f.type), dash(f.note)]),
          ...(b.fields.length === 0 && b.header === "" ? [[`${b.kind} ${b.name}`, "-", "-", "-", "-"]] : []),
        ],
  );
  return { header: ["Block", "Field", "Arguments", "Type", "Directives"], rows, more: doc.total - doc.blocks.length, delimiter: ",", columns: 5 };
}

/** A JUnit report, by the web's own rule (file name, or root element). */
function isJunitPath(path: string, source: Uint8Array): boolean {
  return /\.xml$/i.test(path) && fileKind(path, source.subarray(0, 4096)) === "junit";
}

/** A JUnit report as a table: a totals row, then each failing case with its message; the reason when it is not drawn. Shares the web's parser. */
function junitTable(source: string): Table | string {
  const parsed = parseJunit(source);
  if ("error" in parsed) return `not drawn as test results: ${parsed.error}`;
  const t = parsed.totals;
  const bad = parsed.suites.flatMap((s) =>
    s.cases.filter((c) => c.status === "failed" || c.status === "error").map((c) => [c.status === "error" ? "error" : "failed", (c.classname === "" ? c.name : `${c.classname} › ${c.name}`) || "(unnamed)", c.message.replace(/\s+/g, " ")]),
  );
  const rows = [["total", `${t.tests} tests`, `${t.failures + t.errors} of ${t.tests} tests fail · ${t.skipped} skipped`], ...bad.slice(0, CASE_CAP)];
  return { header: ["Result", "Case", "Message"], rows, more: bad.length - Math.min(bad.length, CASE_CAP), delimiter: ",", columns: 3 };
}

/** `.gcode`: a sliced print, drawn as a table of its facts (layers, box, filament, time). Shares the web's parser. */
function isGcodePath(path: string): boolean {
  return /\.(gcode|gco)$/i.test(path);
}

function gcodeTable(source: string): Table | null {
  const parsed = parseGcode(source);
  if (parsed === undefined) return null;
  return { header: ["Fact", "Value"], rows: gcodeFacts(parsed).map(([k, v]) => [k, v]), more: 0, delimiter: ",", columns: 2 };
}

/** `.geojson`: features, drawn as a table of their geometry type and properties. */
function isGeoJsonPath(path: string): boolean {
  return /\.geojson$/i.test(path);
}

/** The properties table of a GeoJSON file; null when it is not GeoJSON. Shares the web's parser. */
function geoJsonTable(source: string): Table | null {
  const parsed = parseGeoJson(source);
  if (parsed === undefined) return null;
  const { header, rows } = propertyRows(parsed.features);
  return { header, rows, more: Math.max(0, parsed.features.length - rows.length), delimiter: ",", columns: header.length };
}

/** `README.md`, `NOTES.markdown`, `readme` — the prose a repo opens on. */
function isMarkdownPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return fileKind(name, NO_BYTES) === "markdown" || /^readme(\.|$)/i.test(name);
}

/** `.patch` and `.diff`: a file the pull page's diff draws. */
function isPatchPath(path: string): boolean {
  return fileKind(path.slice(path.lastIndexOf("/") + 1), NO_BYTES) === "patch";
}

class Tab {
  loading = true;
  /** Non-empty when there is a reason the bytes are not on screen. */
  note = "";
  noteTitle = "Not shown";
  noteDetail = "";
  raw: Uint8Array | null = null;
  plain: string[] = [];
  lines: Span[][] = [];
  readonly scroll = new Scroll();
  readonly search = new Filter();
  hits: number[] = [];
  hit = 0;
  /** Horizontal scroll, in display columns, for the view mode. */
  left = 0;
  editor: Editor | null = null;
  mode: TabMode = "view";
  /** A file that does not exist at this ref yet. */
  creating = false;
  find: FindMode = "off";
  needle = "";
  replacement = "";
  replaceField: "find" | "with" = "find";
  hint = "";
  /**
   * A picture, when git handed us one. `looksLikeImage` is only an extension
   * filter, so this stays null for a `.png` that turned out to be text — the
   * bytes decide, never the name.
   */
  image: TerminalImage | null = null;
  /** `v`: the picture, or the facts about it. */
  showImage = true;
  /**
   * `v` on prose: the rendered document, or the source that made it. Prose
   * opens rendered because that is what a README is *for*; the source is one
   * keypress away and is what `e` always edits.
   */
  rendered = true;
  /** The rendered document, and the width it was wrapped for. */
  doc: Line[] = [];
  docPlain: string[] = [];
  /** The parsed diff of a patch file; null when the text is not a git diff. */
  patch: Diff | null = null;
  docWidth = 0;
  /** `s` on a CSV/TSV: the aligned table, or the source behind it. */
  asTable = true;
  /** The parsed file, when its name says table. Parse errors ride along. */
  table: Table | null = null;
  grid: Grid = { header: "", rows: [] };
  /** Cues of a subtitle file that could not be read. */
  unread = 0;
  /** Why a file whose name promises a view is shown as source instead; "" when nothing failed. */
  fault = "";
  /** The .ipynb / .log view, and the source it replaces while `s` has it up. */
  kindLines: KindLines | null = null;
  sourceLines: KindLines | null = null;

  constructor(readonly path: string) {}

  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }

  get kind(): TabKind {
    if (this.image !== null) return "image";
    if (isPatchPath(this.path)) return "patch";
    return isMarkdownPath(this.path) ? "markdown" : "code";
  }

  /** True when the pane is showing prose rather than the bytes behind it. */
  get reading(): boolean {
    if (!this.rendered || this.mode !== "view") return false;
    return this.kind === "markdown" || (this.kind === "patch" && this.patch !== null);
  }

  /** True when the pane is showing a CSV/TSV as columns. */
  get tabular(): boolean {
    return (
      this.table !== null &&
      this.table.error === undefined &&
      this.table.header.length > 0 &&
      this.asTable &&
      this.mode === "view"
    );
  }

  /** The lines `/` searches and `j` scrolls: whichever view is up. */
  get body(): string[] {
    if (this.reading) return this.docPlain;
    return this.tabular ? this.grid.rows : this.plain;
  }

  /** Wrap the markdown for this width, and only when the width moved. */
  document(width: number, c: Tokens): void {
    if (this.docWidth === width && this.doc.length > 0) return;
    this.docWidth = width;
    this.doc =
      this.patch !== null
        ? renderPatch(this.patch, Math.max(8, width), c)
        : renderMarkdown(this.plain.join("\n"), Math.max(8, width), c);
    this.docPlain = this.doc.map((line) =>
      line.map((span) => span.text).join(""),
    );
  }

  /** Put up the notebook/log view or its source, whichever `asTable` says. */
  showKind(): void {
    if (this.kindLines === null || this.sourceLines === null) return;
    const shown = this.asTable ? this.kindLines : this.sourceLines;
    this.plain = shown.plain;
    this.lines = shown.lines;
  }

  get modified(): boolean {
    return this.creating || (this.editor !== null && this.editor.modified);
  }

  /** Text the file would be committed with: the buffer if there is one. */
  bytes(): Uint8Array {
    return this.editor?.toBytes() ?? this.raw ?? new Uint8Array(0);
  }

  /** Make the buffer, once, from whatever git handed us. */
  buffer(): Editor | null {
    if (this.editor !== null) return this.editor;
    if (this.raw === null) return null;
    this.editor = new Editor(this.raw, this.path);
    return this.editor;
  }

  /** Re-derive the read view from the buffer, so `esc` keeps the edits. */
  rebuild(c: Tokens): void {
    const source =
      this.editor === null
        ? this.raw
        : new TextEncoder().encode(
            this.editor.lines.join("\n") +
              (this.editor.finalNewline ? "\n" : ""),
          );
    if (source === null) {
      this.plain = [];
      this.lines = [];
      return;
    }
    const text = new TextDecoder().decode(source);
    const built = buildLines(text, this.path, c);
    if (isPatchPath(this.path)) {
      const parsed = parseUnifiedDiff(text);
      this.patch = parsed.files.length > 0 ? parsed : null;
    } else this.patch = null;
    this.plain = built.plain;
    this.lines = built.lines;
    this.unread = 0;
    this.fault = "";
    this.kindLines = null;
    this.sourceLines = built;
    const kind = kindView(this.path, text, c);
    if (kind?.table !== undefined) {
      this.table = kind.table;
      this.grid = layoutTable(kind.table);
    } else if (kind !== null) {
      this.kindLines = kind;
      if (this.asTable && this.mode === "view") {
        this.plain = kind.plain;
        this.lines = kind.lines;
      }
    }
    const api = isOpenApiPath(this.path) ? openapiTable(text, this.path) : null;
    if (isSubtitlePath(this.path)) {
      const subs = subtitleTable(new TextDecoder().decode(source));
      this.table = subs.table;
      this.unread = subs.unread;
      this.grid = layoutTable(this.table);
    } else if (isIcsPath(this.path)) {
      this.table = icsTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isVcfPath(this.path)) {
      this.table = vcfTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isEnvExample(this.path)) {
      this.table = envTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (kindByName(this.path) === "package") {
      this.table = packageTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isEmlPath(this.path)) {
      this.table = emlTable(source);
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isGpxPath(this.path)) {
      this.table = gpxTable(new TextDecoder().decode(source), this.path);
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isHarPath(this.path)) {
      this.table = harTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isSarifPath(this.path)) {
      const findings = sarifTable(new TextDecoder().decode(source));
      this.table = typeof findings === "string" ? null : findings;
      this.fault = typeof findings === "string" ? findings : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isLcovPath(this.path)) {
      const coverage = lcovTable(new TextDecoder().decode(source));
      this.table = typeof coverage === "string" ? null : coverage;
      this.fault = typeof coverage === "string" ? coverage : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (api !== null) {
      this.table = typeof api === "string" ? null : api;
      this.fault = typeof api === "string" ? api : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isDockerfilePath(this.path)) {
      const build = dockerfileTable(new TextDecoder().decode(source));
      this.table = typeof build === "string" ? null : build;
      this.fault = typeof build === "string" ? build : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isWorkflowPath(this.path)) {
      const flow = workflowTable(new TextDecoder().decode(source));
      this.table = typeof flow === "string" ? null : flow;
      this.fault = typeof flow === "string" ? flow : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isSqlPath(this.path)) {
      const schema = sqlTable(new TextDecoder().decode(source));
      this.table = typeof schema === "string" ? null : schema;
      this.fault = typeof schema === "string" ? schema : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isGraphqlPath(this.path)) {
      const schema = graphqlTable(new TextDecoder().decode(source));
      this.table = typeof schema === "string" ? null : schema;
      this.fault = typeof schema === "string" ? schema : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isJunitPath(this.path, source)) {
      const results = junitTable(new TextDecoder().decode(source));
      this.table = typeof results === "string" ? null : results;
      this.fault = typeof results === "string" ? results : "";
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isGcodePath(this.path)) {
      this.table = gcodeTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isGeoJsonPath(this.path)) {
      this.table = geoJsonTable(new TextDecoder().decode(source));
      if (this.table !== null) this.grid = layoutTable(this.table);
    } else if (isTablePath(this.path)) {
      // The decoded source, not `plain`: `expandTabs` has eaten every tab there.
      const delimiter = /\.tsv$/i.test(this.path) ? "\t" : undefined;
      this.table = parseCsv(new TextDecoder().decode(source), { delimiter });
      this.grid = layoutTable(this.table);
    } else if (kind?.table === undefined) this.table = null;
    // The rendered document is derived from the same text, so an edit, a
    // theme switch or a re-read has to throw it away with everything else.
    this.doc = [];
    this.docPlain = [];
    this.docWidth = 0;
    if (this.search.query !== "") this.findHits();
    else this.hits = [];
  }

  findHits(): void {
    const q = this.search.query.toLowerCase();
    const lines = this.body;
    this.hits =
      q === ""
        ? []
        : lines.flatMap((l, i) => (l.toLowerCase().includes(q) ? [i] : []));
    this.hit = 0;
    if (this.hits[0] !== undefined) this.scroll.to(this.hits[0], lines.length);
  }

  step(delta: number): boolean {
    if (this.hits.length === 0) return false;
    this.hit = (this.hit + delta + this.hits.length) % this.hits.length;
    this.scroll.to(this.hits[this.hit]!, this.body.length);
    return true;
  }
}

/** One blob, as the workspace keeps it: text, a picture, or a reason. */
interface CacheEntry {
  readonly note: string;
  /** The note's heading; "Not shown" unless the file is something we name. */
  readonly noteTitle: string;
  /** A last line under the note: where to get the file. */
  readonly noteDetail: string;
  readonly raw: Uint8Array | null;
  readonly picture: Uint8Array | null;
}

// ---- what a workspace remembers between visits ----

/**
 * Leaving a repository for the issue list and coming back should not cost
 * you your open files. The stack already gives that for free while the
 * workspace is *on* it — but popping to the dashboard and re-entering builds
 * a new screen, and the old one's tabs went with it.
 *
 * So a workspace's working set lives on the `Session`, keyed by repository:
 * one connection is one identity, so nothing here can be reached by another
 * user, and it dies with the connection. An entry nobody has touched for
 * half an hour is dropped on the next lookup — a session left open overnight
 * should not be holding yesterday's buffers.
 */
interface Memory {
  tabs: Tab[];
  roots: Node[];
  active: number;
  ref: string;
  focus: "explorer" | "file";
  index: number;
  offset: number;
  touched: number;
}

const MEMORY_IDLE_MS = 30 * 60 * 1000;

/** Which repository this is, on whichever side it was opened from. */
function memoryKey(src: RepoSource): string {
  return src.where.kind === "local"
    ? `repo:${src.where.repo.id}`
    : `origin:${src.where.origin.id}:${src.where.fullName}`;
}

function recall(f: Session, key: string): Memory | undefined {
  const now = Date.now();
  for (const [k, value] of f.scratch) {
    const entry = value as Memory;
    if (now - entry.touched > MEMORY_IDLE_MS) f.scratch.delete(k);
  }
  const hit = f.scratch.get(key);
  return hit === undefined ? undefined : (hit as Memory);
}

// ---- the screen ----

export interface WorkspaceOptions {
  /** The ref to open at. @default the repository's default branch */
  readonly ref?: string;
  /** Open this file in a tab on arrival. */
  readonly open?: string;
  /** Expand the explorer down to this directory. */
  readonly reveal?: string;
  /** Which pane has the keys on arrival. @default "file" */
  readonly focus?: "explorer" | "file";
}

export function workspaceScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  o: WorkspaceOptions = {},
): Screen {
  const key = memoryKey(src);
  const memory = recall(f, key);
  /** This repository on the web, where its media route plays a file; none for a mirror. */
  const mediaWeb = (): string | undefined =>
    src.where.kind === "local" && f.app.config.url !== undefined
      ? `${f.app.config.url.replace(/\/+$/, "")}/${src.where.repo.ownerName}/${src.where.repo.name}`
      : undefined;
  // An explicit `open`/`ref` from the caller wins over what we remembered:
  // arriving from a search hit means "show me *that*", not "show me where I
  // was". Everything else is restored.
  let ref = o.ref ?? memory?.ref ?? knownDefaultRef(src) ?? "";
  /** Where a file downloads from, said in words the terminal can print. */
  const downloadAt = (path: string): string => {
    const web = mediaWeb();
    return web === undefined ? "Download it from its web page." : `Download: ${downloadHref(web, ref, path)}`;
  };
  let facts: RepoFacts | undefined;
  let roots: Node[] = memory?.roots ?? [];
  let loadedTree = roots.length > 0;
  let pinned = false;
  let focus: "explorer" | "file" = o.focus ?? memory?.focus ?? "file";
  /** Below two panes the explorer is a pane you toggle onto, never both. */
  const state = new ListState();
  if (memory !== undefined) {
    state.index = memory.index;
    state.offset = memory.offset;
  }
  const filter = new Filter();
  const tabs: Tab[] = memory?.tabs ?? [];
  let active = memory?.active ?? 0;
  /** True when the tabs came back from memory and need no re-read. */
  const restored = memory !== undefined && tabs.length > 0;
  /** Files marked for deletion by `D`, pending the next commit. */
  const pending = new Set<string>();
  /** Superseded reads (a ref switch, a refresh) land stale and are dropped. */
  let gen = 0;
  let signal: AbortSignal | undefined;
  let subscribed = false;
  let want = o.open ?? "";
  let reveal = o.reveal ?? "";
  const cache = new Map<string, CacheEntry>();
  /** Placement ids: stable per path, so a redraw replaces rather than stacks. */
  const imageIds = new Map<string, number>();
  /** The theme the open tabs were tokenised against. */
  let tokenisedAs = ctx.theme.name;

  const repo = localRepo(src);
  const liveSide = liveOrigin(src);
  const writable = (): boolean => src.capabilities.write && repo !== undefined;
  /**
   * What the ORIGIN says about pushing to the repository behind this one.
   *
   * A live browse gets it from its own `describe()` — the origin answered it
   * already. A mirror cannot: `describe()` on a local source reports
   * `canWrite` *here*, and the question "may I move this branch upstream" is
   * only the upstream's to answer. So a mirror asks the other side once, on
   * load, through the same cached source `W` would open. Undefined means
   * nobody has said, which is the ordinary commit dialog.
   */
  let upstreamPush: boolean | undefined;
  const canPushUpstream = (): boolean | undefined =>
    src.where.kind === "origin" ? facts?.permissions?.push : upstreamPush;
  /** Set when a change made here has to travel to another forge to land. */
  const proposal = (): OriginTarget | undefined =>
    proposeTarget(src, canPushUpstream());
  /**
   * A forge repository you can read and not write: a change to it goes on
   * your fork, as a pull back here (`actions/propose_edit.ts`). A mirror
   * proposes through its origin instead (`proposal`).
   */
  const forkable = (): boolean =>
    !writable() && repo !== undefined && repo.origin == null && f.user !== undefined && src.where.kind === "local";
  /** Editing is allowed wherever the change has somewhere to go. */
  const editable = (): boolean => writable() || proposal() !== undefined || forkable();
  const admin = (): boolean =>
    repo !== undefined && canAdmin(f.db, repo, f.user);
  const readPin = (): void => {
    pinned =
      repo !== undefined &&
      f.user !== undefined &&
      isPinned(f.db, f.user.id, repo.id);
  };

  const tab = (): Tab | undefined => tabs[active];
  /**
   * Hand the working set back to the session on the way out of every frame.
   * The arrays are the live ones, so this is a pointer plus a clock rather
   * than a copy — the cost of remembering is one `Map.set` a paint.
   */
  const rememberView = (): void => {
    f.scratch.set(key, {
      tabs,
      roots,
      active,
      ref,
      focus,
      index: state.index,
      offset: state.offset,
      touched: Date.now(),
    } satisfies Memory);
  };
  /** A read is stale when the ref moved under it, or the screen went away. */
  const stale = (mine: number): boolean =>
    mine !== gen || signal?.aborted === true;
  const rows = (): Node[] => {
    const all = flatten(roots);
    // A partly-loaded tree can only honestly filter what is on screen; `t`
    // is the answer for the whole repository.
    return filter.on ? all.filter((n) => filter.matches(n.name)) : all;
  };
  const cursor = (): Node | undefined => rows()[state.index];

  const changed = (): CommitFile[] => [
    ...tabs
      .filter((t) => t.modified)
      .map(
        (t): CommitFile => ({
          path: t.path,
          kind: t.creating ? "add" : "edit",
        }),
      ),
    ...[...pending].map((path): CommitFile => ({ path, kind: "delete" })),
  ];

  const readOnlyToast = (): void => {
    ctx.toast(
      repo === undefined
        ? "this browse is read-only — W to edit the workbench copy"
        : "you cannot write to this repository",
      "attn",
    );
  };

  // ---- reads ----

  // A directory is listed whole, unlike the web page: `drawTree` paints only
  // the rows on screen, and filtering and reveal need every entry to be there.
  const listDir = async (path: string): Promise<Node[]> => {
    const result = await src.tree(ref, path);
    if (!result.ok) {
      // A repository with no commits has no root tree, and that is not an
      // error to shout about — the explorer says "Empty repository" and the
      // reader gets on with pushing one.
      if (path !== "" || result.error !== "not_found")
        ctx.toast(
          `cannot read ${path || "/"}: ${errorText(result.error)}`,
          "danger",
        );
      return [];
    }
    const depth = path === "" ? 0 : path.split("/").length;
    return result.value.map((entry) => nodeOf(entry, path, depth));
  };

  const expand = async (node: Node): Promise<void> => {
    if (node.children !== null) {
      node.expanded = true;
      ctx.invalidate();
      return;
    }
    node.loading = true;
    ctx.invalidate();
    node.children = await listDir(node.path);
    node.loading = false;
    node.expanded = true;
    ctx.invalidate();
  };

  /** Expand everything above `path` so it becomes a row, and select it. */
  const revealPath = async (path: string): Promise<void> => {
    const isDir = path.endsWith("/");
    const target = isDir ? path.slice(0, -1) : path;
    if (target === "") return;
    const parts = target.split("/");
    const depth = isDir ? parts.length : parts.length - 1;
    let here = "";
    for (let i = 0; i < depth; i++) {
      here = here === "" ? parts[i]! : `${here}/${parts[i]!}`;
      const node = findNode(roots, here);
      if (node === undefined || node.type !== "tree") return;
      await expand(node);
    }
    const index = flatten(roots).findIndex((n) => n.path === target);
    if (index >= 0) state.index = index;
  };

  const remember = (key: string, entry: CacheEntry): void => {
    cache.set(key, entry);
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  /** Fill a tab from git. `fresh` drops whatever the cache held. */
  const loadTab = async (t: Tab, fresh = false): Promise<void> => {
    if (t.creating) {
      t.loading = false;
      return;
    }
    const mine = gen;
    const key = `${ref}:${t.path}`;
    if (fresh) cache.delete(key);
    let entry = cache.get(key);
    if (entry === undefined) {
      t.loading = true;
      ctx.invalidate();
      const read = await src.blob(ref, t.path);
      if (stale(mine)) return;
      let note = "";
      let noteTitle = "Not shown";
      let noteDetail = "";
      // A model is named and measured here, as the page draws it (#7335).
      const model = (bytes: Uint8Array | null, size: number): void => {
        const facts = modelFacts(t.path, bytes, size);
        noteTitle = facts.title;
        note = facts.facts;
        noteDetail = downloadAt(t.path);
      };
      let raw: Uint8Array | null = null;
      let picture: Uint8Array | null = null;
      if (!read.ok)
        note =
          read.error === "not_found"
            ? "No such file at this revision."
            : errorText(read.error);
      else {
        // Audio and video are not played here, and a model is not drawn
        // here: each note says what the file is and where it is.
        const media =
          read.value.kind === "text"
            ? undefined
            : mediaNote(t.path, formatSize(read.value.size), mediaWeb(), ref);
        if (read.value.kind !== "text" && isModelPath(t.path))
          model(read.value.kind === "binary" ? read.value.body : null, read.value.size);
        else if (media !== undefined) note = media;
        else if (read.value.kind === "too_large")
          note = `${formatSize(read.value.size)} — too large to display.`;
        else if (read.value.kind === "binary") {
          // A binary blob whose *name* says picture is the one binary we do
          // something with. Everything else keeps the honest note: showing
          // bytes as text is how a terminal ends up beeping at you.
          if (looksLikeImage(t.path)) picture = read.value.body;
          else
            note =
              archiveNote(t.path, read.value.body, read.value.size, formatSize) ??
              `Binary file, ${formatSize(read.value.size)}.`;
        } else raw = read.value.body; // .html included: source here, the page preview is web-only
      }
      entry = { note, noteTitle, noteDetail, raw, picture };
      remember(key, entry);
    }
    if (stale(mine)) return;
    t.loading = false;
    t.note = entry.note;
    t.noteTitle = entry.noteTitle;
    t.noteDetail = entry.noteDetail;
    t.raw = entry.raw;
    t.image =
      entry.picture === null
        ? null
        : prepareImage(entry.picture, imageId(t.path), ctx.caps);
    t.showImage = true;
    t.rendered = true;
    t.asTable = true;
    t.editor = null;
    t.mode = "view";
    t.find = "off";
    t.scroll.top = 0;
    t.left = 0;
    t.rebuild(ctx.theme.c);
    ctx.invalidate();
  };

  /** One id per path for the life of the workspace. */
  const imageId = (path: string): number => {
    const known = imageIds.get(path);
    if (known !== undefined) return known;
    const made = imageIds.size + 1;
    imageIds.set(path, made);
    return made;
  };

  /** `enter` on a file: activate its tab, or make one and stream it in. */
  const openTab = async (path: string): Promise<void> => {
    const at = tabs.findIndex((t) => t.path === path);
    if (at >= 0) {
      active = at;
      focus = "file";
      ctx.invalidate();
      return;
    }
    const made = new Tab(path);
    tabs.push(made);
    active = tabs.length - 1;
    focus = "file";
    // The tab is on screen before the read starts: opening a file must never
    // look like nothing happened.
    ctx.invalidate();
    await loadTab(made);
  };

  /** A mirror's credit line (#10531), the same sentence the web page prints; empty until read. */
  let creditWords = "";
  const askCredit = async (mine: number): Promise<void> => {
    if (repo === undefined || ref === "") return;
    const credit = await creditOf(f.db, f.app.reposRoot, repo, f.user, src, ref);
    if (stale(mine)) return;
    const words = credit === undefined ? "" : creditText(credit);
    if (words === creditWords) return;
    creditWords = words;
    ctx.invalidate();
  };

  const reload = async (arriving = false): Promise<void> => {
    const mine = ++gen;
    readPin();
    const described = await src.describe();
    if (stale(mine)) return;
    if (described.ok) {
      facts = described.value;
      if (ref === "") ref = described.value.defaultBranch;
      ctx.invalidate();
    } else if (ref === "") {
      ctx.toast(errorText(described.error), "danger");
      return;
    }
    void askUpstream(mine);
    void askCredit(mine);
    // Coming back to a workspace we remember: the tree and every buffer are
    // already here, edits included. Re-reading them would be slower *and*
    // would throw away uncommitted work, so the only thing worth asking git
    // is what `describe` just answered. `r` is the refresh.
    if (arriving && restored && want === "" && reveal === "") return;
    roots = await listDir("");
    if (stale(mine)) return;
    loadedTree = true;
    ctx.invalidate();
    if (reveal !== "") {
      await revealPath(reveal);
      reveal = "";
    }
    if (want !== "") {
      const target = want;
      want = "";
      await revealPath(target);
      await openTab(target);
      return;
    }
    if (tabs.length > 0) {
      for (const t of tabs) await loadTab(t, true);
      return;
    }
    const first = landing(roots);
    if (first === undefined) return;
    await revealPath(first.path);
    await openTab(first.path);
    // The README opens, and the keys stay in the file pane so it can be read
    // straight away — the whole complaint the workspace exists to answer.
    focus = o.focus ?? "file";
  };

  /**
   * Ask the origin whether this mirror's upstream is one we may push to.
   *
   * Detached from `reload` on purpose: the answer only changes a label and a
   * dialog, and a workspace must open at the speed of git rather than at the
   * speed of somebody else's API. It is one request a minute at worst — the
   * browse cache holds a `describe` for sixty seconds — and a failure simply
   * leaves the ordinary commit dialog, which is what a mirror had before.
   */
  const askUpstream = async (mine: number): Promise<void> => {
    if (src.where.kind !== "local" || repo?.origin == null) return;
    if (upstreamPush !== undefined) return;
    const other = otherSide(f, src);
    if (other === undefined) return;
    const described = await other.describe();
    if (stale(mine) || !described.ok) return;
    upstreamPush = described.value.permissions?.push;
    ctx.invalidate();
  };

  // ---- mutations ----

  /**
   * Why the change breaks a schema one of its JSON files names, or
   * undefined. The same check the web form makes before a save.
   */
  const schemaCheck = async (
    files: readonly { path: string; content: Uint8Array | null }[],
  ): Promise<string | undefined> => {
    const read = async (p: string): Promise<string | undefined> => {
      const blob = await src.blob(ref, p);
      return blob.ok && blob.value.kind === "text" ? new TextDecoder().decode(blob.value.body) : undefined;
    };
    for (const file of files) {
      if (file.content === null) continue;
      const refused = await schemaRefusal(file.path, new TextDecoder().decode(file.content), read);
      if (refused !== undefined) return refused;
    }
    return undefined;
  };

  const commit = (): void => {
    const target = proposal();
    if (!writable() && target === undefined && !forkable()) {
      readOnlyToast();
      return;
    }
    const files = changed();
    if (files.length === 0) {
      ctx.toast(
        "nothing to commit — e edits a file, D marks one for deletion",
        "attn",
      );
      return;
    }
    const first = files[0]!;
    const subject =
      files.length > 1
        ? `Update ${plural(files.length, "file")}`
        : first.kind === "delete"
          ? `Delete ${first.path}`
          : `${first.kind === "add" ? "Add" : "Update"} ${first.path}`;
    /** The bytes for one ticked path: the buffer if there is one, else gone. */
    const payload = (paths: readonly string[]) => {
      const chosen = new Set(paths);
      return files
        .filter((file) => chosen.has(file.path))
        .map((file) => ({
          path: file.path,
          content:
            file.kind === "delete"
              ? null
              : (tabs.find((t) => t.path === file.path)?.bytes() ??
                new Uint8Array(0)),
        }));
    };
    if (target !== undefined) {
      proposeChange(target, files, subject, payload);
      return;
    }
    if (forkable() && repo !== undefined) {
      proposeHere(repo, files, subject, payload);
      return;
    }
    if (repo === undefined) {
      readOnlyToast();
      return;
    }
    const here = repo;
    ctx.push(
      commitScreen(f, ctx, screen, {
        repo: here,
        where: `${here.ownerName}/${here.name}`,
        branch: ref,
        title: files.length > 1 ? "Commit changes" : `Commit ${first.path}`,
        subject,
        files,
        defaultBranchName: suggestBranch(f, "edit", slug(first.path)),
        commit: async (plan) => {
          const broken = await schemaCheck(payload(plan.paths));
          if (broken !== undefined) return err(broken);
          const made = await editFiles(f.app, f.user, here, {
            branch: ref,
            base: ref,
            ...(plan.newBranch === undefined
              ? {}
              : { newBranch: plan.newBranch }),
            message: plan.message,
            files: payload(plan.paths),
            ...(plan.pull === undefined ? {} : { openPull: plan.pull }),
          });
          if (!made.ok) return err(editErrorText(made.error));
          const result = made.value;
          return ok({
            message:
              result.pull === undefined
                ? `committed to ${result.branch}`
                : `committed to ${result.branch} · pull #${result.pull.number} opened`,
            then: () => {
              // The commit landed: the workspace follows it. A new branch
              // becomes the ref being browsed, every buffer is re-read from
              // what git now holds, and the pending deletions are gone
              // because they happened.
              for (const t of tabs) t.creating = false;
              pending.clear();
              ref = result.branch;
              runAsync(ctx, reload);
            },
          });
        },
      }),
    );
  };

  /**
   * The same dialog, for a forge repository you can only read: the commit
   * goes on a branch of your fork (made if you have none) and a pull asks
   * for it here — what the web's Propose change does.
   */
  const proposeHere = (
    here: Repo,
    files: readonly CommitFile[],
    subject: string,
    payload: (paths: readonly string[]) => {
      path: string;
      content: Uint8Array | null;
    }[],
  ): void => {
    const first = files[0]!;
    const base = ref === "" ? here.defaultBranch : ref;
    const fullName = `${here.ownerName}/${here.name}`;
    ctx.push(
      commitScreen(f, ctx, screen, {
        repo: here,
        where: fullName,
        branch: ref,
        title: "Propose a change",
        subject,
        files,
        mode: "propose",
        upstream: { fullName, base },
        defaultBranchName: suggestBranch(f, "edit", slug(first.path)),
        commit: async (plan) => {
          const chosen = payload(plan.paths);
          const broken = await schemaCheck(chosen);
          if (broken !== undefined) return err(broken);
          const sent = await proposeEdit(f.app, f.user, here, {
            base,
            files: chosen,
            message: plan.message,
            title: plan.pull?.title ?? subject,
            ...(plan.pull?.body === undefined ? {} : { body: plan.pull.body }),
            ...(plan.newBranch === undefined ? {} : { branch: plan.newBranch }),
          });
          if (!sent.ok) return err(proposeEditText(sent.error));
          const pull = sent.value.pull;
          return ok({
            message: `opened pull #${pull.number} on ${fullName} from ${sent.value.head.ownerName}/${sent.value.head.name}`,
            then: () => {
              // The work lives on the fork and in the pull: the buffers go
              // back to what this repository holds.
              for (const t of tabs) {
                t.creating = false;
                t.editor = null;
                t.mode = "view";
                t.rebuild(ctx.theme.c);
              }
              pending.clear();
              ctx.invalidate();
            },
          });
        },
      }),
    );
  };

  /**
   * The same dialog, aimed at somebody else's forge.
   *
   * One call does the whole of it (`actions/contribute.ts`): fork if a fork
   * is needed, branch from the *upstream's* base rather than a stale copy of
   * it, commit into the fork, push it there, and open the pull upstream with
   * the `owner:branch` head form. Everything this function adds is the two
   * sentences a person reads afterwards.
   */
  const proposeChange = (
    target: OriginTarget,
    files: readonly CommitFile[],
    subject: string,
    payload: (paths: readonly string[]) => {
      path: string;
      content: Uint8Array | null;
    }[],
  ): void => {
    const first = files[0]!;
    const base = ref === "" ? (facts?.defaultBranch ?? "") : ref;
    ctx.push(
      commitScreen(f, ctx, screen, {
        where: target.fullName,
        branch: ref,
        title: "Propose a change",
        subject,
        files,
        mode: "propose",
        upstream: { fullName: target.fullName, base },
        defaultBranchName: suggestBranch(f, "edit", slug(first.path)),
        commit: async (plan) => {
          const sent = await propose(f, {
            target,
            base,
            branch: plan.newBranch ?? "",
            message: plan.message,
            files: payload(plan.paths),
            pull: plan.pull ?? { title: subject },
          });
          if (!sent.ok) return err(contributeErrorText(sent.error));
          const result = sent.value;
          const number = result.pull?.number;
          const imported = importedInto(f, result);
          return ok({
            message:
              number === undefined
                ? `pushed ${result.branch} to your fork`
                : `opened pull #${number} on ${target.fullName}`,
            then: () => {
              // The work lives in the fork and in the pull now, so the
              // buffers here go back to being what the upstream holds —
              // keeping them would offer to propose the same change twice.
              for (const t of tabs) {
                t.creating = false;
                t.editor = null;
                t.mode = "view";
                t.rebuild(ctx.theme.c);
              }
              pending.clear();
              ctx.invalidate();
              if (imported !== undefined)
                ctx.push(
                  pullScreen(f, ctx, local(f, imported.repo), imported.number),
                );
            },
          });
        },
      }),
    );
  };

  const switchRef = (chosen: string): void => {
    if (chosen === ref) return;
    const go = (): void => {
      ref = chosen;
      cache.clear();
      pending.clear();
      for (const t of tabs) {
        t.editor = null;
        t.mode = "view";
        t.creating = false;
      }
      runAsync(ctx, reload);
    };
    const dirty = tabs.filter((t) => t.modified).length;
    if (dirty === 0) {
      go();
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Switch ref",
        body: [
          `${plural(dirty, "tab")} ${dirty === 1 ? "has" : "have"} uncommitted changes.`,
          `Switching to ${chosen} reloads every tab from it.`,
        ],
        actions: [
          { label: "Keep editing", variant: "ghost" },
          { label: "Switch", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index === 1) go();
        },
      }),
    );
  };

  const newBranch = (): void => {
    if (!writable() || repo === undefined) {
      readOnlyToast();
      return;
    }
    ctx.push(
      promptScreen(ctx, screen, {
        title: "New branch",
        label: `branch name (from ${ref})`,
        placeholder: `${f.user?.username ?? "work"}/thing`,
        hint:
          repo.origin === null
            ? "created here, and the workspace switches to it"
            : `created on ${repo.origin.fullName} first, then here`,
        onSubmit: (name) => {
          if (name === "") return NAME_THE_BRANCH;
          return (async () => {
            const made = await createBranch(f.app, f.user, repo, {
              name,
              from: ref,
            });
            if (!made.ok) {
              ctx.toast(errorText(made.error), "danger");
              return;
            }
            ctx.toast(`created ${name}`, "success");
            switchRef(name);
          })();
        },
      }),
    );
  };

  const closeTab = (index: number): void => {
    const doomed = tabs[index];
    if (doomed === undefined) return;
    const drop = (): void => {
      tabs.splice(index, 1);
      active = Math.max(
        0,
        Math.min(active >= index ? active - 1 : active, tabs.length - 1),
      );
      if (tabs.length === 0) focus = "explorer";
      ctx.invalidate();
    };
    if (!doomed.modified) {
      drop();
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Close tab",
        body: [
          `${doomed.path} has uncommitted changes.`,
          "They are not committed anywhere.",
        ],
        actions: [
          { label: "Keep it open", variant: "ghost" },
          { label: "Discard", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index2) => {
          if (index2 === 1) drop();
        },
      }),
    );
  };

  const discard = (t: Tab): void => {
    if (!t.modified) {
      ctx.toast("nothing to discard", "attn");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Discard changes",
        body: [`Throw away the edits to ${t.path}?`, "This cannot be undone."],
        actions: [
          { label: "Keep editing", variant: "ghost" },
          { label: "Discard", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index !== 1) return;
          t.editor = null;
          t.mode = "view";
          t.rebuild(ctx.theme.c);
          ctx.toast(`discarded the changes to ${t.path}`, "success");
          ctx.invalidate();
        },
      }),
    );
  };

  const markDeleted = (node: Node): void => {
    if (!editable()) {
      readOnlyToast();
      return;
    }
    if (node.type !== "blob") {
      ctx.toast("only files can be deleted here", "attn");
      return;
    }
    if (pending.has(node.path)) {
      pending.delete(node.path);
      ctx.toast(`${node.path} is no longer marked for deletion`, "success");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Delete file",
        body: [
          `Mark ${node.path} for deletion?`,
          "It goes with the next commit — c reviews everything first.",
        ],
        actions: [
          { label: "Cancel", variant: "ghost" },
          { label: "Delete", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index !== 1) return;
          pending.add(node.path);
          ctx.toast(
            `${node.path} marked for deletion — c to commit`,
            "success",
          );
          ctx.invalidate();
        },
      }),
    );
  };

  const newFile = (): void => {
    if (!editable()) {
      readOnlyToast();
      return;
    }
    const node = cursor();
    const dir =
      node === undefined
        ? ""
        : node.type === "tree"
          ? node.path
          : node.path.slice(0, node.path.lastIndexOf("/"));
    ctx.push(
      promptScreen(ctx, screen, {
        title: "New file",
        label: "path",
        value: dir === "" ? "" : `${dir}/`,
        placeholder: "src/thing.ts",
        hint: "the file is created by the commit, not by this prompt",
        onSubmit: (value) => {
          const path = value.replace(/^\/+/, "").trim();
          if (path === "" || path.endsWith("/")) return "give the file a name";
          if (tabs.some((t) => t.path === path))
            return "that file is already open";
          const made = new Tab(path);
          made.creating = true;
          made.loading = false;
          made.raw = new Uint8Array(0);
          made.rebuild(ctx.theme.c);
          made.mode = "edit";
          made.buffer();
          tabs.push(made);
          active = tabs.length - 1;
          focus = "file";
          ctx.invalidate();
          return undefined;
        },
      }),
    );
  };

  const edit = (): void => {
    const t = tab();
    if (t === undefined) {
      ctx.toast("open a file first", "attn");
      return;
    }
    if (!editable()) {
      readOnlyToast();
      return;
    }
    if (t.raw === null) {
      ctx.toast(
        t.image !== null
          ? "a picture is not something this editor can change"
          : t.note === ""
            ? "that file is not editable here"
            : t.note,
        "attn",
      );
      return;
    }
    const buffer = t.buffer();
    if (buffer === null) return;
    if (buffer.readOnly) {
      ctx.toast(buffer.readOnlyReason, "attn");
      return;
    }
    // You edit the bytes, never the rendering of them. Leaving `rendered`
    // set would put the document back on `esc` with the edits invisible.
    t.rendered = false;
    t.asTable = false;
    t.showKind();
    t.mode = "edit";
    focus = "file";
    ctx.invalidate();
  };

  const swap = (): void => {
    const other = otherSide(f, src);
    if (other === undefined) {
      ctx.toast("this repository has only one side", "attn");
      return;
    }
    const go = (): void => {
      const at = tab()?.path;
      ctx.replace(
        workspaceScreen(f, ctx, other, {
          ref,
          ...(at === undefined ? {} : { open: at }),
          focus,
        }),
      );
    };
    if (!tabs.some((t) => t.modified)) {
      go();
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Switch sides",
        body: [
          "There are uncommitted changes in this workspace.",
          "Opening the other side leaves them behind.",
        ],
        actions: [
          { label: "Stay here", variant: "ghost" },
          { label: "Switch", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index === 1) go();
        },
      }),
    );
  };

  // ---- keys ----

  const explorerKeys = (): Binding[] => [
    binding(["tab"], "focus file"),
    binding(["enter", "l"], "open / expand"),
    binding(["h"], "collapse"),
    binding(["/"], "filter this level"),
    binding(["n", "D"], "new file / delete", { disabled: !editable() }),
  ];

  const fileKeys = (): Binding[] => {
    const t = tab();
    if (t?.mode === "edit")
      return [
        binding(["esc"], "back to reading"),
        binding(["ctrl+s"], "commit"),
        binding(["ctrl+f", "ctrl+r"], "find / replace"),
        binding(["ctrl+z", "ctrl+y"], "undo / redo"),
        binding(["ctrl+c", "ctrl+x", "ctrl+v"], "copy / cut / paste"),
      ];
    const two =
      t !== undefined &&
      (t.image !== null || isMarkdownPath(t.path) || t.patch !== null);
    return [
      ...(t?.table == null && t?.kindLines == null
        ? []
        : [
            binding(["s"], t.asTable ? "show the source" : "show the table", {
              disabled: t.table != null && (t.table.error !== undefined || t.table.header.length === 0),
            }),
          ]),
      binding(["tab"], "focus explorer"),
      binding(["e"], "edit", { disabled: !editable() }),
      binding(
        ["v"],
        t?.image !== null && t !== undefined
          ? t.showImage
            ? "file details"
            : "show the picture"
          : t?.rendered === true
            ? "show the source"
            : "render it",
        { disabled: !two },
      ),
      binding(["/", "n", "N"], "search in file"),
      binding(["u"], "discard changes", { disabled: t?.modified !== true }),
    ];
  };

  const screen: Screen = {
    ...(repo === undefined ? {} : { repoId: repo.id }),
    commands: () => [
      ...workingCommands(f, ctx, repo),
      ...tellCommands(f, ctx, () => screen, repo),
      ...reportCommands(f, ctx, () => screen, repo),
      ...reportsCommands(f, ctx, repo),
      ...noteCommands(f, ctx, () => screen, repo),
      ...yoursCommands(f, ctx, repo),
      ...transferRepoCommands(f, ctx, repo),
      ...deleteRepoCommands(f, ctx, repo),
      ...grantsCommands(f, ctx, repo),
      ...forgeItCommands(f, ctx, repo, () => screen),
      ...hooksCommands(f, ctx, repo),
      ...visionCommands(f, ctx, repo),
      ...labelsCommands(f, ctx, repo),
      ...buildsCommands(f, ctx, repo),
      ...iterationsCommands(f, ctx, repo),
      ...displayCommands(f, ctx, repo),
      ...appEnvCommands(f, ctx, repo),
      ...variantsCommands(f, ctx, repo),
      ...autonomyCommands(f, ctx, repo),
      ...trafficCommands(f, ctx, repo),
      ...schedulesCommands(f, ctx, repo),
      ...dataImportCommands(f, ctx, repo),
      ...jobsCommands(f, ctx, repo),
      ...chaptersCommands(f, ctx, repo),
      ...queueCommands(f, ctx, repo),
      ...blockedCommands(f, ctx, repo),
      ...statementCommands(f, ctx, repo),
      ...moneyCommands(f, ctx, repo),
      ...adapterCommands(f, ctx, repo),
      ...atlasCommands(f, ctx, repo),
    ],
    get title() {
      return sourceName(src);
    },
    get keys(): Binding[] {
      const t = tab();
      const editing = t?.mode === "edit";
      const other = otherSideLabel(f, src);
      const out: Binding[] = [
        ...(focus === "explorer" ? explorerKeys() : fileKeys()),
        ...(editing
          ? []
          : [
              binding(["]", "["], "next / previous tab"),
              binding(["x", "X"], "close tab / others"),
              binding(["c"], proposal() === undefined ? "commit" : "propose a change", {
                disabled: !editable(),
              }),
              binding(["b", "B"], "switch ref / new branch"),
              ...(repo === undefined ? [] : [binding(["f"], "forks, most work first")]),
              binding(["t", "ctrl+p"], "find file"),
              binding(["y"], "copy path"),
              binding(["i", "p", "C"], "issues / pulls / commits"),
              binding(["I"], "about this repository"),
              binding(["V"], "waves"),
              ...(repo === undefined ? [] : [binding(["d"], "production deploys")]),
              ...(repo === undefined ? [] : [binding(["H"], "runs, by state")]),
              ...(repo !== undefined && canSeeAnswers(f.db, repo, f.user)
                ? [binding(["a"], "your issues and the crew's answers")]
                : []),
              ...(repo !== undefined && admin()
                ? [binding(["R"], `decisions by ${(getRepoById(f.db, repo.id) ?? repo).decisionsBy} (cycle)`)]
                : []),
              ...liveBindings(src),
              ...(liveSide?.mirroredAs === undefined
                ? []
                : [binding(["w"], "open the workbench copy")]),
              ...(other === undefined ? [] : [binding(["W"], other)]),

              ...(originTarget(src) === undefined && repo === undefined
                ? []
                : [
                    binding(
                      ["F"],
                      originTarget(src) === undefined
                        ? "fork"
                        : `fork at ${originTarget(src)?.host ?? "the origin"}`,
                      { disabled: !f.signedIn },
                    ),
                  ]),
              ...(repo === undefined || canWrite(f.db, repo, f.user)
                ? []
                : [binding(["Y"], "make it yours", { disabled: !f.signedIn })]),
              ...(repo === undefined
                ? []
                : [
                    binding(["P"], pinned ? "unpin" : "pin", {
                      disabled: !f.signedIn,
                    }),
                    binding(["S"], "sync now", {
                      disabled: repo.origin === null || !admin(),
                    }),
                    binding([","], "settings", { disabled: !admin() }),
                  ]),
              ...(repo !== undefined &&
              admin() &&
              getMirrorTarget(f.db, repo.id) !== undefined
                ? [binding(["U"], "stop mirroring to the source")]
                : []),
              binding(["r"], "refresh"),
              binding(
                ["E"],
                hasExternalEditor() ? "open $FORGE_EDITOR" : "external editor",
              ),
            ]),
      ];
      return out;
    },
    load(sig) {
      // `load` is called once per screen today, but the contract does not
      // promise that, and a second call with a fresh signal would leave the
      // first subscription live on a screen nobody can see. One flag makes
      // re-entry idempotent instead of relying on the loop's current shape.
      const again = subscribed;
      signal = sig;
      subscribed = true;
      if (repo !== undefined && !again)
        liveUpdates(f, sig, { repoId: repo.id }, () => {
          readPin();
          ctx.invalidate();
        });
      return reload(!again);
    },
    render(area, s) {
      const c = ctx.theme.c;
      const set = ctx.icons;
      // A theme switch changes what every token *is*, and the spans in an
      // open tab were built against the old palette. Rebuilding here rather
      // than on the keypress keeps the loop from knowing that tabs exist.
      if (tokenisedAs !== ctx.theme.name) {
        tokenisedAs = ctx.theme.name;
        for (const t of tabs) t.rebuild(c);
      }
      const stripRows = whereRows(src);
      const [strip, bar, body, status] = split(area, "v", [
        len(stripRows),
        len(1),
        fill(1),
        len(1),
      ]);
      // The where strip keeps column zero on every repository screen — the
      // grammar is the same everywhere — and the ref pill takes the right
      // hand end of the same row.
      whereStrip(s, strip!, c, f, src, set);
      drawRefPill(s, strip!, c, ref, whereSpans(f, src, c, set));
      for (const place of whereLayout(f, src, strip!, set))
        ctx.hit(place.rect, () => clickPlace(place.kind));
      for (const drawn of drawTabBar(s, bar!, c, tabs, active, set)) {
        ctx.hit(drawn.rect, () => {
          active = drawn.index;
          focus = "file";
        });
        if (drawn.close !== undefined)
          ctx.hit(drawn.close, () => closeTab(drawn.index));
      }

      const wide = ctx.twoPane;
      const [leftArea, divider, rightArea] = wide
        ? split(body!, "h", [
            len(Math.min(EXPLORER_MAX, Math.max(EXPLORER_MIN, body!.w >> 2))),
            len(1),
            fill(1),
          ])
        : focus === "explorer"
          ? [body!, undefined, undefined]
          : [undefined, undefined, body!];

      if (leftArea !== undefined) {
        const [box, list] = filter.on
          ? split(leftArea, "v", [len(1), fill(1)])
          : [undefined, leftArea];
        if (box !== undefined) {
          const caret = filter.render(s, box, c, "filter this level");
          if (focus === "explorer") ctx.setCursor(caret);
        }
        const nodes = rows();
        drawTree(s, list!, c, state, nodes, {
          focused: focus === "explorer",
          openPaths: new Set(tabs.map((t) => t.path)),
          modified: new Set(tabs.filter((t) => t.modified).map((t) => t.path)),
          pending,
          currentPath: tab()?.path ?? "",
          empty: loadedTree ? "Empty repository" : "Reading…",
          icons: set,
        });
        // Click selects; clicking what is already selected opens it, which
        // for a directory means expand. Exactly what `enter` does, so the
        // two gestures cannot drift apart.
        hitList(ctx, list!, state, nodes.length, {
          select: () => {
            focus = "explorer";
          },
          open: (index) => {
            focus = "explorer";
            openNode(nodes[index]);
          },
        });
      }
      if (divider !== undefined)
        for (let y = divider.y; y < divider.y + divider.h; y++)
          s.set(
            divider.x,
            y,
            focus === "file" ? G.vHeavy : G.v,
            style(focus === "file" ? c.accent : c.border, c.bg),
          );

      // One column of air between the divider and the first line number:
      // code pressed against a rule is the difference between a layout and
      // a dump.
      if (rightArea !== undefined) {
        const pane = {
          ...rightArea,
          x: rightArea.x + 1,
          w: Math.max(1, rightArea.w - 1),
        };
        drawPane(s, pane, c);
        const t = tab();
        ctx.hit(pane, {
          click: () => {
            focus = "file";
          },
          wheel: (delta) => {
            focus = "file";
            if (t !== undefined && t.mode === "view")
              t.scroll.to(t.scroll.top + delta, t.body.length);
          },
        });
      }
      drawStatus(s, status!, c);
      rememberView();
    },
    paste(text) {
      const t = tab();
      if (t === undefined) return false;
      if (t.mode === "edit" && t.find === "off") {
        t.editor?.insert(text);
        return true;
      }
      if (t.find !== "off") {
        const clean = text.replace(/\n/g, "");
        if (t.replaceField === "find") t.needle += clean;
        else t.replacement += clean;
        return true;
      }
      return false;
    },
    key(e) {
      const t = tab();

      // Modal boxes first: a find box, or a filter, owns every key while it
      // is open, so nothing beneath it can steal a character.
      if (t !== undefined && t.mode === "edit" && t.find !== "off")
        return findKey(t, e);
      if (
        focus === "file" &&
        t !== undefined &&
        t.mode === "view" &&
        t.search.active
      ) {
        const handled = t.search.key(e);
        if (handled) t.findHits();
        return handled;
      }
      if (focus === "explorer" && filter.active) {
        const handled = filter.key(e);
        if (handled) state.clamp(rows().length);
        return handled;
      }

      // The buffer owns the keyboard while it is being typed into; only the
      // three that mean "stop typing" are taken from it.
      if (t !== undefined && t.mode === "edit") return editKey(t, e);

      // Everything below is a bare letter. A modified key is never one of
      // them — `ctrl+u` is a page, not "discard", and `ctrl+d` is a page, not
      // a delete — so the guard is applied once here rather than remembered
      // twenty times.
      const plain = !e.ctrl && !e.alt;

      if (e.key === "tab") {
        focus = focus === "explorer" ? "file" : "explorer";
        if (focus === "file" && tabs.length === 0) focus = "explorer";
        return true;
      }
      if (e.key === "esc" && focus === "file") {
        focus = "explorer";
        return true;
      }

      // ---- tabs ----
      if ((plain && e.key === "]") || (e.ctrl && e.key === "n")) {
        if (tabs.length > 0) active = (active + 1) % tabs.length;
        return true;
      }
      if (plain && e.key === "[") {
        if (tabs.length > 0) active = (active - 1 + tabs.length) % tabs.length;
        return true;
      }
      if (plain && /^[1-9]$/.test(e.key)) {
        const at = Number(e.key) - 1;
        if (tabs[at] !== undefined) {
          active = at;
          focus = "file";
        }
        return true;
      }
      if (plain && e.key === "x") {
        closeTab(active);
        return true;
      }
      if (plain && e.key === "X") {
        const keep = tab();
        if (keep !== undefined) {
          const others = tabs.filter(
            (other) => other !== keep && other.modified,
          );
          if (others.length > 0) {
            ctx.toast(
              `${plural(others.length, "other tab")} still ${others.length === 1 ? "has" : "have"} changes — x closes one at a time`,
              "attn",
            );
            return true;
          }
          tabs.splice(0, tabs.length, keep);
          active = 0;
        }
        return true;
      }
      if (plain && e.key === "u" && focus === "file" && t !== undefined) {
        discard(t);
        return true;
      }
      if (plain && e.key === "v") {
        toggleView();
        return true;
      }
      if (plain && e.key === "s" && focus === "file" && t !== undefined) {
        toggleTable(t);
        return true;
      }

      // ---- the repository ----
      if (plain && e.key === "c") {
        commit();
        return true;
      }
      if (plain && e.key === "b") {
        // The ref pill's own list: every branch and tag, what has drifted,
        // and `enter` to switch the whole workspace onto one.
        ctx.push(
          branchesScreen(f, ctx, src, { current: ref, onPick: switchRef }),
        );
        return true;
      }
      if (plain && e.key === "f" && repo !== undefined) {
        ctx.push(forksScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "B") {
        newBranch();
        return true;
      }
      if ((plain && e.key === "t") || (e.ctrl && e.key === "p")) {
        ctx.push(
          finderScreen(f, ctx, screen, src, ref, (path) => {
            runAsync(ctx, async () => {
              await revealPath(path);
              await openTab(path);
            });
          }),
        );
        return true;
      }
      if (plain && e.key === "y") {
        const path =
          focus === "file" ? (t?.path ?? "") : (cursor()?.path ?? "");
        if (path === "") return true;
        ctx.copy(path);
        ctx.toast(`copied ${path}`, "success");
        return true;
      }
      if (plain && e.key === "i") {
        ctx.push(issuesScreen(f, ctx, src, "issue"));
        return true;
      }
      if (plain && e.key === "p") {
        ctx.push(issuesScreen(f, ctx, src, "pull"));
        return true;
      }
      if (plain && e.key === "C") {
        ctx.push(commitsScreen(f, ctx, src, ref));
        return true;
      }
      if (plain && e.key === "V") {
        ctx.push(wavesScreen(f, ctx, src));
        return true;
      }
      if (plain && e.key === "d" && repo !== undefined) {
        ctx.push(deploysScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "H" && repo !== undefined) {
        ctx.push(runsScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "a" && repo !== undefined && canSeeAnswers(f.db, repo, f.user)) {
        ctx.push(answersScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "I") {
        ctx.push(aboutScreen(f, ctx, screen, src, facts, ref));
        return true;
      }
      if (plain && e.key === "O") {
        const url = originFileUrl(src, ref, t?.path ?? "");
        if (url === "") {
          ctx.toast("this repository has no origin page", "attn");
          return true;
        }
        openLink(ctx, url);
        return true;
      }
      if (plain && e.key === "W") {
        swap();
        return true;
      }
      if (
        plain &&
        liveKey(f, ctx, e, src, { parent: screen, onDone: openLocal })
      )
        return true;
      if (plain && e.key === "w" && liveSide?.mirroredAs !== undefined) {
        openLocal(liveSide.mirroredAs);
        return true;
      }
      if (plain && e.key === "P") {
        togglePin();
        return true;
      }
      if (
        plain &&
        e.key === "S" &&
        repo !== undefined &&
        repo.origin !== null &&
        admin()
      ) {
        runAsync(ctx, async () => {
          const synced = await syncRepoNow(f.app, f.user, repo);
          if (!synced.ok) ctx.toast(errorText(synced.error), "danger");
          else if (synced.value.error !== "")
            ctx.toast(synced.value.error, "danger");
          else {
            await reload();
            ctx.toast("synced from the origin", "success");
          }
        });
        return true;
      }
      if (
        plain &&
        e.key === "U" &&
        repo !== undefined &&
        admin() &&
        getMirrorTarget(f.db, repo.id) !== undefined
      ) {
        const source = getMirrorTarget(f.db, repo.id)?.fullName ?? "";
        // The only way out of a mirror, and there is no way back in from
        // here: ask first, naming the repository and where it goes.
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Stop mirroring",
            body: [
              `Stop mirroring ${repo.ownerName}/${repo.name} to ${source}?`,
              "Nothing more is pushed there, and this cannot be",
              "turned back on from here.",
            ],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Stop mirroring", variant: "danger" },
            ],
            selected: 0,
            width: 64,
            onChoose: (choice) => {
              if (choice !== 1) return;
              const stopped = stopMirroring(f.app, f.user, repo);
              ctx.toast(
                stopped.ok && stopped.value ? "stopped mirroring" : "not mirrored",
                stopped.ok && stopped.value ? "success" : "danger",
              );
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (plain && e.key === "Y" && f.signedIn && repo !== undefined) {
        ctx.push(makeItYoursScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "F" && f.signedIn) {
        // A repository that lives at an origin is forked *there* — a local
        // fork of a mirror would be a copy of a copy, with nowhere to
        // propose it back to. A native repository keeps the native fork.
        const target = originTarget(src);
        if (target !== undefined)
          forkAtOrigin(f, ctx, {
            parent: screen,
            target,
            onForked: openLocal,
          });
        else if (repo !== undefined) ctx.push(forkScreen(f, ctx, repo));
        return true;
      }
      if (plain && e.key === "," && repo !== undefined && admin()) {
        openOnWeb(
          f,
          ctx,
          `/${repo.ownerName}/${repo.name}/settings`,
          "Settings",
        );
        return true;
      }
      if (plain && e.key === "R" && repo !== undefined && admin()) {
        // `repo` was read when the screen opened; the rule is read afresh.
        const target = getRepoById(f.db, repo.id) ?? repo;
        const next =
          DECISIONS_BY[(DECISIONS_BY.indexOf(target.decisionsBy) + 1) % DECISIONS_BY.length]!;
        runAsync(ctx, async () => {
          const done = await setDecisionsBy(f.app, f.user, target, next, false);
          if (!done.ok) {
            ctx.toast("only a person who administers this sets its standing rule", "danger");
            return;
          }
          reload();
          ctx.toast(`decisions here go by ${next}`, "success");
        });
        return true;
      }
      if (plain && e.key === "r") {
        cache.clear();
        runAsync(ctx, reload);
        return true;
      }
      if (plain && e.key === "E") {
        openExternal();
        return true;
      }
      // `e` works from either pane: from the explorer it opens the file under
      // the cursor first, because "edit this" and "open this" are one wish.
      if (plain && e.key === "e") {
        const node = focus === "explorer" ? cursor() : undefined;
        if (node !== undefined && node.type === "blob" && node.path !== t?.path)
          runAsync(ctx, async () => {
            await openTab(node.path);
            edit();
          });
        else edit();
        return true;
      }

      // ---- whichever pane has the keys ----
      if (focus === "file") return t === undefined ? false : viewKey(t, e);

      const list = rows();
      if (state.key(e, list.length)) return true;
      const node = list[state.index];
      if (e.key === "/") {
        filter.open();
        return true;
      }
      if (e.key === "l" || e.key === "right" || e.key === "enter") {
        openNode(node);
        return true;
      }
      if (e.key === "h" || e.key === "left") {
        if (node === undefined) return true;
        if (node.type === "tree" && node.expanded) {
          node.expanded = false;
          return true;
        }
        const parent = node.path.slice(0, node.path.lastIndexOf("/"));
        if (parent === "") return true;
        const index = flatten(roots).findIndex((n) => n.path === parent);
        if (index >= 0) state.index = index;
        return true;
      }
      if (e.key === "n") {
        newFile();
        return true;
      }
      if (e.key === "D") {
        if (node !== undefined) markDeleted(node);
        return true;
      }
      return false;
    },
  };

  /** `enter` (or a second click) on an explorer row: expand it, or open it. */
  function openNode(node: Node | undefined): void {
    if (node === undefined) return;
    if (node.type === "tree") {
      if (node.expanded) node.expanded = false;
      else runAsync(ctx, () => expand(node));
      return;
    }
    runAsync(ctx, () => openTab(node.path));
  }

  function togglePin(): void {
    if (f.user === undefined || repo === undefined) return;
    const wanted = !pinned;
    const done = wanted
      ? pinRepo(f.app, f.user, repo)
      : unpinRepo(f.app, f.user, repo);
    if (!done.ok && wanted) ctx.toast(errorText(done.error), "danger");
    else {
      readPin();
      ctx.invalidate();
      ctx.toast(wanted ? "pinned" : "unpinned", "success");
    }
  }

  /**
   * Clicking a place in the where-strip goes there. Each dot already says
   * whether the repository is at that place; the click is the obvious
   * follow-up, and it is the same act the keyboard already has a letter for.
   */
  function clickPlace(kind: "origin" | "workbench" | "machine"): void {
    if (kind === "machine") {
      togglePin();
      return;
    }
    const other = otherSide(f, src);
    const here =
      (kind === "workbench" && src.where.kind === "local") ||
      (kind === "origin" && src.where.kind === "origin");
    if (here) {
      ctx.toast("this is where you are reading from", "attn");
      return;
    }
    if (other !== undefined) {
      swap();
      return;
    }
    const url = originUrl(src);
    if (url === "") ctx.toast("this repository has no other side", "attn");
    else openLink(ctx, url);
  }

  function openLocal(next: Repo): void {
    ctx.replace(workspaceScreen(f, ctx, local(f, next)));
  }

  /** `E`: hand the file to the operator's own editor and commit what comes back. */
  function openExternal(): void {
    if (!hasExternalEditor()) {
      ctx.toast(editorHint(), "attn");
      return;
    }
    const t = tab();
    if (t === undefined || t.raw === null) {
      ctx.toast(
        t === undefined ? "no file open" : "that file is not text",
        "attn",
      );
      return;
    }
    externalEditor(f, ctx, {
      path: t.path,
      body: t.bytes(),
      onEdited: (bytes) => {
        // What comes back lands in the tab's own buffer, not in a commit
        // dialog of its own: the workspace is where a change lives until `c`,
        // and an external edit is a change like any other. Splicing it in
        // through the editor's one mutation keeps it undoable, and keeps
        // `modified` honest when the file came back untouched.
        const buffer = t.buffer();
        if (buffer === null) return;
        const body = new TextDecoder()
          .decode(bytes)
          .replace(/\r\n/g, "\n")
          .replace(/\n$/, "");
        buffer.anchor = { row: 0, col: 0 };
        const last = buffer.lines.length - 1;
        buffer.cursor = {
          row: last,
          col: [...(buffer.lines[last] ?? "")].length,
        };
        buffer.insert(body);
        t.mode = "view";
        t.rebuild(ctx.theme.c);
        focus = "file";
        ctx.toast(
          buffer.modified
            ? `${t.path} edited \u2014 c to commit`
            : `${t.path} came back unchanged`,
          buffer.modified ? "success" : "attn",
        );
        ctx.invalidate();
      },
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Edit mode: three keys leave, the buffer owns the rest. */
  function editKey(t: Tab, e: KeyEvent): boolean {
    const buffer = t.editor;
    if (buffer === null) return false;
    if (e.key === "esc") {
      t.mode = "view";
      t.rebuild(ctx.theme.c);
      return true;
    }
    if (e.ctrl && e.key === "s") {
      commit();
      return true;
    }
    if (e.ctrl && (e.key === "f" || e.key === "r")) {
      t.find = e.key === "f" ? "find" : "replace";
      t.replaceField = "find";
      t.needle = "";
      t.replacement = "";
      t.hint = "";
      return true;
    }
    if (e.ctrl && e.key === "g") {
      t.hint = buffer.seek(t.needle, true) ? "" : "no match";
      return true;
    }
    if (e.ctrl && e.key === "c") {
      // The editor's register *and* the reader's own clipboard: over SSH
      // those are two different places.
      ctx.copy(buffer.copy());
      t.hint = "copied";
      return true;
    }
    const handled = buffer.key(e);
    if (handled) t.hint = "";
    return handled;
  }

  /** Read mode: scroll, search, and the two keys that change what is open. */
  function viewKey(t: Tab, e: KeyEvent): boolean {
    if (e.key === "/") {
      t.search.open();
      return true;
    }
    if (e.key === "n" && !e.ctrl) return t.step(1);
    if (e.key === "N") return t.step(-1);
    // Horizontal scrolling belongs to code, which has long lines and a
    // gutter; prose and pictures are already fitted to the pane.
    if ((e.key === "l" || e.key === "right") && !t.reading) {
      t.left += 8;
      return true;
    }
    if ((e.key === "h" || e.key === "left") && !t.reading) {
      t.left = Math.max(0, t.left - 8);
      return true;
    }
    return t.scroll.key(e, t.body.length);
  }

  /**
   * `v` — the same key on both kinds of file that have two ways to be seen.
   *
   * A picture toggles between the pixels and what the file *is*; prose
   * toggles between the rendered document and the source that made it. One
   * letter, because in both cases the question is the same: "show me the
   * other view of this".
   */
  function toggleView(): void {
    const t = tab();
    if (t === undefined) return;
    if (t.image !== null) {
      t.showImage = !t.showImage;
      return;
    }
    if ((t.kind !== "markdown" && t.kind !== "patch") || t.mode === "edit") {
      ctx.toast("nothing else to show for this file", "attn");
      return;
    }
    t.rendered = !t.rendered;
    t.scroll.top = 0;
    // The hits were line numbers in the *other* view; recompute or drop them.
    t.findHits();
  }

  /** `s` — a table file's two views: aligned columns, or the text itself. */
  function toggleTable(t: Tab): void {
    // A stray `s` on anything else is not worth a toast.
    if (t.mode === "edit") return;
    if (t.kindLines !== null && t.sourceLines !== null) {
      t.asTable = !t.asTable;
      t.showKind();
      t.scroll.top = 0;
      t.left = 0;
      t.findHits();
      return;
    }
    if (t.table === null) return;
    if (t.table.error !== undefined) {
      ctx.toast(tableProblem(t.table), "attn");
      return;
    }
    t.asTable = !t.asTable;
    t.scroll.top = 0;
    t.left = 0;
    t.findHits();
  }

  function drawPane(s: Surface, r: Rect, c: Tokens): void {
    const t = tab();
    if (t === undefined) {
      emptyState(s, r, c, {
        title: loadedTree ? "No file open" : "Reading…",
        body:
          loadedTree && roots.length === 0
            ? "Push a branch to get started."
            : "tab moves to the explorer; enter opens a file in a tab.",
      });
      return;
    }
    if (t.loading && t.lines.length === 0 && t.image === null) {
      emptyState(s, r, c, { title: "Reading…", body: t.path });
      return;
    }
    if (t.image !== null) {
      drawPicture(s, r, c, t, t.image);
      return;
    }
    if (t.note !== "") {
      emptyState(s, r, c, {
        title: t.noteTitle,
        body: t.note,
        ...(t.noteDetail === "" ? {} : { detail: t.noteDetail }),
      });
      return;
    }
    if (t.mode === "edit") {
      const caret = t.editor?.render(s, r, c, focus === "file") ?? null;
      if (focus === "file") ctx.setCursor(caret);
      return;
    }
    if (t.reading) {
      // The README the repository opens on, rendered the way the web
      // renders it. `v` shows the bytes; `e` edits them, always.
      t.document(Math.max(8, r.w - 2), c);
      drawDoc(s, r, c, t);
      return;
    }
    if (t.tabular) {
      drawTable(s, r, c, t);
      return;
    }
    drawCode(s, r, c, t);
  }

  /**
   * A picture, or the facts about one.
   *
   * `drawImage` reserves the cells and hands back bytes for the loop to
   * write after the frame; when the terminal cannot show a picture it draws
   * its own placeholder card and hands back nothing, which is also exactly
   * what we want the loop to do about a previous placement — take it away.
   */
  function drawPicture(
    s: Surface,
    r: Rect,
    c: Tokens,
    t: Tab,
    image: TerminalImage,
  ): void {
    if (!t.showImage) {
      const inner = card(s, r, c, { title: t.name });
      drawFacts(s, inner, c, [
        ["format", (image.format ?? "unknown").toUpperCase()],
        [
          "dimensions",
          image.width > 0 ? `${image.width} × ${image.height}` : "unknown",
        ],
        ["size", humanBytes(image.byteLength)],
        ["path", t.path],
        ["terminal", `${ctx.caps.term ?? "unknown"} · ${ctx.caps.graphics}`],
        ["cell", `${ctx.caps.cell.width}×${ctx.caps.cell.height}px${
          ctx.caps.cell.measured ? "" : " (assumed)"
        }`],
      ]);
      return;
    }
    const placed = drawImage(s, r, c, image, ctx.caps);
    if (placed !== undefined) ctx.placeImage(placed);
  }

  /**
   * The rendered document, with `/` hits tinted the way the code view tints
   * them. Prose searched the same way code does and then said nothing about
   * what it found: `n` moved the viewport and the reader had to guess which
   * line was the answer. The row under the hit wears `c.muted`, exactly as
   * `drawCode` does — one grammar for "this is what you searched for".
   */
  function drawDoc(s: Surface, r: Rect, c: Tokens, t: Tab): void {
    if (r.w <= 0 || r.h <= 0) return;
    if (t.hits.length === 0) {
      drawLines(s, r, c, t.scroll, t.doc);
      return;
    }
    const hits = new Set(t.hits);
    const from = t.scroll.window(r.h, t.doc.length);
    const width = Math.max(0, r.w - 1);
    for (let i = 0; i < r.h; i++) {
      const row = from + i;
      const line = t.doc[row];
      if (line === undefined) break;
      const y = r.y + i;
      if (!hits.has(row)) {
        s.spans(r.x, y, line, r.x + width);
        continue;
      }
      s.fill({ x: r.x, y, w: width, h: 1 }, " ", style(c.fg, c.muted));
      s.spans(
        r.x,
        y,
        line.map((span) => ({ ...span, style: { ...span.style, bg: c.muted } })),
        r.x + width,
      );
    }
    scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
      total: t.doc.length,
      offset: from,
    });
  }

  function drawStatus(s: Surface, r: Rect, c: Tokens): void {
    const t = tab();
    s.fill(r, " ", style(c.mutedFg, c.muted));
    const right = r.x + r.w;

    // A find box takes the whole row while it is open — the text it searches
    // is above it, and covering that is the one thing a search box must not do.
    if (t !== undefined && t.find !== "off") {
      const noteW = t.hint === "" ? 0 : t.hint.length + 2;
      if (noteW > 0)
        s.text(right - noteW + 1, r.y, t.hint, style(c.attn, c.muted), right);
      const room = Math.max(6, r.w - noteW);
      const half = t.find === "replace" ? room >> 1 : room;
      const findCaret = input(s, { x: r.x, y: r.y, w: half, h: 1 }, c, {
        value: t.needle,
        placeholder: "find",
        focused: t.replaceField === "find",
        ...(t.replaceField === "find" ? { cursor: [...t.needle].length } : {}),
      });
      let withCaret = null;
      if (t.find === "replace")
        withCaret = input(
          s,
          { x: r.x + half, y: r.y, w: room - half, h: 1 },
          c,
          {
            value: t.replacement,
            placeholder: "replace with",
            focused: t.replaceField === "with",
            ...(t.replaceField === "with"
              ? { cursor: [...t.replacement].length }
              : {}),
          },
        );
      ctx.setCursor(t.replaceField === "find" ? findCaret : withCaret);
      return;
    }
    if (
      t !== undefined &&
      focus === "file" &&
      t.mode === "view" &&
      t.search.on
    ) {
      const caret = t.search.render(s, r, c, "search in file");
      if (t.search.active) ctx.setCursor(caret);
      const hits =
        t.search.query === ""
          ? ""
          : t.hits.length === 0
            ? "no match"
            : `${t.hit + 1}/${t.hits.length}`;
      if (hits !== "")
        s.text(
          right - hits.length - 1,
          r.y,
          hits,
          style(c.faint, c.muted),
          right,
        );
      return;
    }

    const dirty = tabs.filter((x) => x.modified).length;
    const target = proposal();
    // A mirror that stopped says so on every frame, not only in settings.
    const held = repo === undefined ? undefined : getMirrorTarget(f.db, repo.id);
    const parts = [
      ref === "" ? "no ref" : ref,
      held === undefined ? "" : mirrorLine(held),
      creditWords,
      dirty === 0 ? "" : `${dirty} modified`,
      pending.size === 0 ? "" : `${plural(pending.size, "deletion")} pending`,
      // Said on every frame, not only in the dialog: somebody typing into a
      // repository they cannot push to should never have to press `c` to
      // find out where their change is going.
      target === undefined ? "" : proposingStatus(target),
    ].filter((p) => p !== "");
    s.text(
      r.x + 1,
      r.y,
      truncate(parts.join(" · "), Math.max(0, r.w - 2)),
      style(
        dirty + pending.size > 0 ? c.attn : c.mutedFg,
        c.muted,
        dirty > 0 ? BOLD : 0,
      ),
      right,
    );
    const tail =
      t === undefined
        ? ""
        : t.mode === "edit" && t.editor !== null
          ? t.editor.status()
          : t.image !== null
            ? `${t.path} · ${(t.image.format ?? "image").toUpperCase()} ${
                t.image.width > 0
                  ? `${t.image.width}×${t.image.height} `
                  : ""
              }· ${humanBytes(t.image.byteLength)}`
            : t.note !== ""
              ? ""
              : `${t.path} · ${
                  t.tabular && t.table !== null
                    ? t.raw !== null && isJunitPath(t.path, t.raw)
                      ? plural(t.table.rows.length - 1 + t.table.more, "failing case")
                      : tableStatus(t.table, t.unread, isSubtitlePath(t.path), isIcsPath(t.path), isGpxPath(t.path), isVcfPath(t.path), isGeoJsonPath(t.path), isJsonlPath(t.path), isSarifPath(t.path), isLcovPath(t.path), isOpenApiPath(t.path), isDockerfilePath(t.path))
                    : `${plural(
                        t.reading ? t.doc.length : t.plain.length,
                        "line",
                      )}${t.reading ? " rendered" : ""}${
                        t.table?.error === undefined || t.mode === "edit"
                          ? ""
                          : ` · ${tableProblem(t.table)}`
                      }${t.fault === "" || t.mode === "edit" ? "" : ` · ${t.fault}`}`
                }${
                  writable() || target !== undefined ? "" : forkable() ? " · proposes from your fork" : " · read only"
                }`;
    if (tail === "") return;
    const shown = truncate(tail, Math.max(0, r.w - 4));
    s.text(
      right - displayWidth(shown) - 1,
      r.y,
      shown,
      style(c.faint, c.muted),
      right,
    );
  }

  return screen;
}

/**
 * The find/replace box's own keys. It is modal on purpose: while it is up
 * every character typed belongs to it, so nothing underneath can steal one.
 */
function findKey(t: Tab, e: KeyEvent): boolean {
  const buffer = t.editor;
  if (e.key === "esc") {
    t.find = "off";
    return true;
  }
  if (e.key === "tab" && t.find === "replace") {
    t.replaceField = t.replaceField === "find" ? "with" : "find";
    return true;
  }
  if (e.key === "enter") {
    if (buffer === null) return true;
    if (t.find === "find") {
      t.hint = buffer.seek(t.needle, !e.shift) ? "" : "no match";
    } else {
      t.hint = `${buffer.replaceAll(t.needle, t.replacement)} replaced`;
      t.find = "off";
    }
    return true;
  }
  const value = t.replaceField === "find" ? t.needle : t.replacement;
  const set = (next: string): void => {
    if (t.replaceField === "find") t.needle = next;
    else t.replacement = next;
  };
  if (e.key === "backspace") {
    set([...value].slice(0, -1).join(""));
    return true;
  }
  if (!e.ctrl && !e.alt && [...e.key].length === 1) set(value + e.key);
  return true;
}

// ---- drawing ----

/** `main ▾`, right-aligned on the where-strip's row. */
function drawRefPill(
  s: Surface,
  r: Rect,
  c: Tokens,
  ref: string,
  strip: readonly Span[],
): void {
  if (r.w <= 0 || r.h <= 0) return;
  const label = `${truncate(ref === "" ? "…" : ref, 24)} ${G.caretDown}`;
  const used = strip.reduce((sum, span) => sum + displayWidth(span.text), 0);
  const x = r.x + r.w - displayWidth(label) - 1;
  // Never draw over the strip: it says where the bytes came from, which is
  // the more important of the two.
  if (x <= r.x + used + 2) return;
  s.text(x, r.y, label, style(c.accent, c.bg, BOLD), r.x + r.w);
}

/** Where one tab landed: the whole chip, and the `✗` inside it if it has one. */
interface TabHit {
  readonly index: number;
  readonly rect: Rect;
  readonly close?: Rect;
}

/**
 * The tab bar. One row: the paths, the active one bold and underlined in the
 * accent, a dot on anything modified, `¶` on prose being read rather than
 * edited, and `‹ ›` when there are more than fit.
 *
 * The active tab wears a `✗`. Only the active one: a close box on every chip
 * is a row of targets you can hit by accident, and the tab you mean to close
 * is almost always the one you are looking at.
 */
function drawTabBar(
  s: Surface,
  r: Rect,
  c: Tokens,
  tabs: readonly Tab[],
  active: number,
  set: IconSet = "plain",
): TabHit[] {
  if (r.w <= 0 || r.h <= 0) return [];
  s.fill(r, " ", style(c.mutedFg, c.bg));
  const right = r.x + r.w;
  if (tabs.length === 0) {
    s.text(r.x + 1, r.y, "no tabs open", style(c.faint, c.bg), right);
    return [];
  }
  const hits: TabHit[] = [];
  const count = `${plural(tabs.length, "tab")} `;
  const room = Math.max(10, r.w - count.length - 2);
  // The icon is nerd-only: the plain set's generic file mark before every
  // path says nothing and costs two columns on the one row that has none.
  const mark = (t: Tab): string =>
    set === "nerd" ? `${fileIcon(t.path, set)} ` : "";
  const label = (t: Tab): string =>
    ` ${mark(t)}${truncate(t.path, 30)}${t.modified ? " ●" : ""}${
      t.reading ? ` ${PROSE_MARK}` : ""
    } `;
  const widths = tabs.map(
    (t, i) => displayWidth(label(t)) + (i === active ? 2 : 0) + 1,
  );

  // A window that contains the active tab and fits: grow left from it, then
  // right, so the tab you are on is never the one that scrolled off.
  let first = Math.max(0, Math.min(active, tabs.length - 1));
  let last = first;
  let used = widths[first] ?? 0;
  for (;;) {
    const before = first > 0 ? (widths[first - 1] ?? 0) : Infinity;
    const after = last + 1 < tabs.length ? (widths[last + 1] ?? 0) : Infinity;
    if (after <= before && used + after <= room) {
      used += after;
      last++;
    } else if (before < Infinity && used + before <= room) {
      used += before;
      first--;
    } else break;
  }

  let x = r.x;
  if (first > 0)
    x = s.text(
      x,
      r.y,
      `${G.chevron === "›" ? "‹" : "<"}`,
      style(c.faint, c.bg),
      right,
    );
  for (let i = first; i <= last; i++) {
    const t = tabs[i];
    if (t === undefined) break;
    const on = i === active;
    const from = x;
    x = s.text(
      x,
      r.y,
      label(t),
      style(
        on ? c.accent : t.modified ? c.attn : c.mutedFg,
        c.bg,
        on ? BOLD | UNDERLINE : 0,
      ),
      right,
    );
    let close: Rect | undefined;
    if (on) {
      close = { x, y: r.y, w: 2, h: 1 };
      x = s.text(x, r.y, `${G.cross} `, style(c.faint, c.bg), right);
    }
    hits.push({
      index: i,
      rect: { x: from, y: r.y, w: x - from, h: 1 },
      ...(close === undefined ? {} : { close }),
    });
    x += 1;
  }
  if (last < tabs.length - 1) s.text(x, r.y, "›", style(c.faint, c.bg), right);
  s.text(right - count.length, r.y, count, style(c.faint, c.bg), right);
  return hits;
}

interface TreeDrawOpts {
  readonly focused: boolean;
  readonly openPaths: ReadonlySet<string>;
  readonly modified: ReadonlySet<string>;
  readonly pending: ReadonlySet<string>;
  readonly currentPath: string;
  readonly empty: string;
  readonly icons: IconSet;
}

/**
 * The explorer rows. Indentation plus a caret is the whole grammar: `▸`/`▾`
 * on a directory, a dot on a file with unsaved changes, a struck-through name
 * on one marked for deletion, and the accent on whatever the file pane holds.
 */
function drawTree(
  s: Surface,
  r: Rect,
  c: Tokens,
  state: ListState,
  nodes: readonly Node[],
  o: TreeDrawOpts,
): void {
  if (r.w <= 0 || r.h <= 0) return;
  if (nodes.length === 0) {
    s.text(
      r.x + 2,
      r.y,
      truncate(o.empty, Math.max(0, r.w - 2)),
      style(c.faint, c.bg),
      r.x + r.w,
    );
    return;
  }
  const from = state.window(r.h, nodes.length);
  const right = r.x + r.w - 1;
  for (let i = 0; i < r.h; i++) {
    const node = nodes[from + i];
    if (node === undefined) break;
    const y = r.y + i;
    const selected = from + i === state.index;
    const bg = selected && o.focused ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: r.w - 1, h: 1 }, " ", style(c.fg, bg));
    let x = r.x + Math.min(node.depth * 2, Math.max(0, r.w - 8));
    const mark =
      node.type === "tree"
        ? node.loading
          ? G.ellipsis
          : node.expanded
            ? G.caretDown
            : G.caretRight
        : " ";
    // The caret is the expansion state and stays whatever the set. A Nerd
    // Font adds the *kind* beside it — the plain set does not, because six
    // shades of `▭` before six filenames is noise, not information.
    const glyph =
      o.icons === "nerd"
        ? `${mark}${fileIcon(node.path, o.icons, {
            directory: node.type === "tree",
            open: node.expanded,
          })} `
        : `${mark} `;
    x = s.text(x, y, glyph, style(c.mutedFg, bg), right);
    const doomed = o.pending.has(node.path);
    const dirty = o.modified.has(node.path);
    const current = node.type === "blob" && node.path === o.currentPath;
    const label = node.type === "tree" ? `${node.name}/` : node.name;
    const meta = doomed
      ? "delete"
      : dirty
        ? "●"
        : node.type === "blob"
          ? ""
          : "";
    const metaW = meta === "" ? 0 : meta.length + 1;
    s.text(
      x,
      y,
      truncate(label, Math.max(0, right - x - metaW)),
      style(
        doomed
          ? c.danger
          : current
            ? c.accent
            : o.openPaths.has(node.path)
              ? c.fg
              : node.type === "tree"
                ? c.fg
                : c.mutedFg,
        bg,
        (current || selected ? BOLD : 0) | (doomed ? STRIKE : 0),
      ),
      right - metaW,
    );
    if (meta !== "")
      s.text(
        right - meta.length,
        y,
        meta,
        style(doomed ? c.danger : c.attn, bg),
        right,
      );
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total: nodes.length,
    offset: from,
  });
}

/** The read view: a pinned gutter, syntax colour, and horizontal scrolling. */
function drawCode(s: Surface, r: Rect, c: Tokens, t: Tab): void {
  if (r.w <= 0 || r.h <= 0) return;
  const total = t.plain.length;
  const gutter = String(Math.max(1, total)).length + 1;
  const textX = r.x + gutter;
  const textW = Math.max(1, r.w - gutter - 1);
  const from = t.scroll.window(r.h, total);
  for (let i = 0; i < r.h; i++) {
    const row = from + i;
    if (row >= total) break;
    const y = r.y + i;
    const isHit = t.hits.includes(row);
    const bg = isHit ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: Math.max(0, r.w - 1), h: 1 }, " ", style(c.fg, bg));
    s.text(
      r.x,
      y,
      pad(String(row + 1), gutter - 1, "right"),
      style(c.faint, bg),
      textX,
    );
    const spans = t.lines[row] ?? [];
    if (t.left === 0 && bg === c.bg) {
      s.spans(textX, y, spans, textX + textW);
    } else {
      drawShifted(s, textX, y, spans, t.left, textW, bg);
    }
    if (t.left > 0) s.set(textX - 1, y, G.chevron, style(c.faint, bg), textX);
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h }, c, {
    total,
    offset: from,
  });
}

/** `80 rows, first 50 shown · 3 more columns`: what the table leaves out. */
function tableStatus(table: Table, unread = 0, subs = false, events = false, facts = false, people = false, features = false, jsonl = false, findings = false, files = false, operations = false, instructions = false): string {
  const rows = table.rows.length + table.more;
  return `${plural(rows, subs ? "cue" : events ? "event" : people ? "contact" : facts ? "fact" : features ? "feature" : findings ? "finding" : files ? "file" : operations ? "operation" : instructions ? "instruction" : "row")}${
    unread > 0 ? ` · ${unread} unreadable, check their arrow lines` : ""
  }${
    table.more > 0
      ? jsonl
        ? `, ${plural(table.more, "more row")} not shown`
        : `, first ${table.rows.length} shown`
      : ""
  }${
    table.columns > MAX_COLUMNS
      ? ` · ${table.columns - MAX_COLUMNS} more columns`
      : ""
  }`;
}

/** The one line a broken table file gets: where, and what. */
function tableProblem(table: Table): string {
  return table.error === undefined
    ? ""
    : `not a table: line ${table.error.line}, ${table.error.message}`;
}

/**
 * A table: the header pinned on the top row in bold, the data scrolling under
 * it, `t.left` shifting both so a wide table can be read across.
 */
function drawTable(s: Surface, r: Rect, c: Tokens, t: Tab): void {
  if (r.w <= 1 || r.h <= 1) return;
  const textW = r.w - 1;
  const rows = t.grid.rows;
  const body = r.h - 1;
  const from = t.scroll.window(body, rows.length);
  const hits = new Set(t.hits);
  s.fill({ x: r.x, y: r.y, w: textW, h: 1 }, " ", style(c.fg, c.bg));
  drawShifted(
    s,
    r.x,
    r.y,
    [{ text: t.grid.header, style: style(c.accent, c.bg, BOLD) }],
    t.left,
    textW,
    c.bg,
  );
  for (let i = 0; i < body; i++) {
    const row = from + i;
    if (row >= rows.length) break;
    const y = r.y + 1 + i;
    const bg = hits.has(row) ? c.muted : c.bg;
    s.fill({ x: r.x, y, w: textW, h: 1 }, " ", style(c.fg, bg));
    drawShifted(
      s,
      r.x,
      y,
      [{ text: rows[row]!, style: style(c.fg, bg) }],
      t.left,
      textW,
      bg,
    );
  }
  scrollbar(s, { x: r.x + r.w - 1, y: r.y + 1, w: 1, h: body }, c, {
    total: rows.length,
    offset: from,
  });
}

/** Draw spans clipped to a window of display columns. */
function drawShifted(
  s: Surface,
  x: number,
  y: number,
  spans: readonly Span[],
  left: number,
  width: number,
  bg: number,
): void {
  const right = x + width;
  let dcol = 0;
  let cx = x;
  for (const span of spans) {
    for (const ch of clusters(span.text)) {
      const w = displayWidth(ch);
      if (dcol + w > left && dcol < left + width)
        cx = s.text(cx, y, ch, { ...span.style, bg }, right);
      dcol += w;
      if (dcol >= left + width) return;
    }
  }
}

// ---- the doors other screens knock on ----

/** Open a repository's workspace. */
export function repoScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  o: WorkspaceOptions = {},
): Screen {
  return workspaceScreen(f, ctx, src, o);
}

/** Open the workspace with one file already in a tab. */
export function blobScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path: string,
): Screen {
  return workspaceScreen(f, ctx, src, { ref, open: path, focus: "file" });
}

/** Open the workspace with the explorer expanded to a directory. */
export function treeScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  ref: string,
  path = "",
): Screen {
  return workspaceScreen(f, ctx, src, {
    ref,
    ...(path === "" ? {} : { reveal: `${path}/` }),
    focus: "explorer",
  });
}
