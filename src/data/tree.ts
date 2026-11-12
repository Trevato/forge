/**
 * The forge's data as a file tree: repos → apps → environments → files →
 * tables → rows. Pure: which nodes are open and what to filter by come in,
 * the visible lines go out. Reads happen only for an open file or table.
 */
import { PAGE_SIZE, rows as readRows, tables as readTables, type RowsResult, type TableInfo } from "./browse.ts";
import { rowObject, cellLine, type Cell } from "./shape.ts";
import type { Source } from "./sources.ts";

export type Kind = "repo" | "app" | "env" | "file" | "table" | "row";

export interface Node {
  /** Unique path; a child's key starts with its parent's. */
  readonly key: string;
  readonly kind: Kind;
  readonly depth: number;
  readonly label: string;
  /** The file this node is in or is (not on a repo, app or env). */
  readonly source?: Source;
  readonly table?: string;
  /** A table's row count, for paging; the label is only for display. */
  readonly total?: number;
  /** A row's JSON, masked as every read is. */
  readonly json?: Record<string, Cell>;
}

const SEP = "\u0001";
const join = (parent: string, part: string): string => (parent === "" ? part : parent + SEP + part);
const isUnder = (key: string, parent: string): boolean => key.startsWith(parent + SEP);

/**
 * What was read from the files, kept so a rebuild of the tree reads nothing
 * it has read: each open file's tables once, each open table's page once.
 * Drop it to read afresh.
 */
export interface Reads {
  readonly tables: Map<string, TableInfo[]>;
  readonly pages: Map<string, RowsResult | undefined>;
}
export const newReads = (): Reads => ({ tables: new Map(), pages: new Map() });

/** The pages of a table of `total` rows. */
export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE));

/**
 * Every node that is visible with `open` expanded, in order. `page` is the
 * zero-based page of each open table, by its key. Reads happen only for an
 * open file or table, and once each while `reads` is kept.
 */
export function visible(
  sources: readonly Source[],
  open: ReadonlySet<string>,
  reads: Reads = newReads(),
  page: ReadonlyMap<string, number> = new Map(),
): Node[] {
  const out: Node[] = [];
  const tableNodes = (file: Node, depth: number) => {
    const source = file.source!;
    let list = reads.tables.get(file.key);
    if (list === undefined) {
      try {
        list = readTables(source);
      } catch {
        list = [];
      }
      reads.tables.set(file.key, list);
    }
    for (const t of list) {
      const key = join(file.key, t.name);
      const at = page.get(key) ?? 0;
      const paged = t.rows > PAGE_SIZE ? `  page ${at + 1}/${pageCount(t.rows)}` : "";
      const node: Node = { key, kind: "table", depth, label: `${t.name}  ${t.rows} rows${open.has(key) ? paged : ""}`, source, table: t.name, total: t.rows };
      out.push(node);
      if (!open.has(node.key)) continue;
      const pk = `${key}${SEP}${at}`;
      if (!reads.pages.has(pk)) {
        try {
          reads.pages.set(pk, readRows(source, t.name, { page: at }));
        } catch {
          reads.pages.set(pk, undefined);
        }
      }
      const got = reads.pages.get(pk);
      for (const [i, r] of (got?.rows ?? []).entries())
        out.push({
          key: join(node.key, String(i)),
          kind: "row",
          depth: depth + 1,
          label: r.map(cellLine).join(" | "),
          source,
          table: t.name,
          json: rowObject(got!.columns, r),
        });
    }
  };
  const fileNode = (source: Source, key: string, depth: number, label: string) => {
    const node: Node = { key, kind: "file", depth, label, source };
    out.push(node);
    if (open.has(key)) tableNodes(node, depth + 1);
  };
  for (const s of sources.filter((x) => x.where === undefined)) fileNode(s, join("", `file:${s.id}`), 0, `${s.label}.db`);
  const byRepo = Map.groupBy(
    sources.filter((x) => x.where !== undefined),
    (s) => s.where!.repo,
  );
  for (const [repo, ofRepo] of byRepo) {
    const rk = join("", `repo:${repo}`);
    out.push({ key: rk, kind: "repo", depth: 0, label: repo });
    if (!open.has(rk)) continue;
    for (const [app, ofApp] of Map.groupBy(ofRepo, (s) => s.where!.app)) {
      const ak = join(rk, `app:${app}`);
      out.push({ key: ak, kind: "app", depth: 1, label: app });
      if (!open.has(ak)) continue;
      for (const [env, ofEnv] of Map.groupBy(ofApp, (s) => s.where!.env)) {
        const ek = join(ak, `env:${env}`);
        out.push({ key: ek, kind: "env", depth: 2, label: env });
        if (!open.has(ek)) continue;
        for (const s of ofEnv) fileNode(s, join(ek, `file:${s.id}`), 3, s.where!.file);
      }
    }
  }
  return out;
}

/** Whether a node opens at all (a row is a leaf). */
export const opens = (n: Node): boolean => n.kind !== "row";

/**
 * `text` keeps the lines that contain it (any case) and the lines above
 * them that lead there; an empty `text` keeps everything.
 */
export function filtered(nodes: readonly Node[], text: string): Node[] {
  const want = text.trim().toLowerCase();
  if (want === "") return [...nodes];
  const hits = nodes.filter((n) => n.label.toLowerCase().includes(want));
  return nodes.filter((n) => hits.some((h) => h.key === n.key || isUnder(h.key, n.key)));
}

/** The parent line's key, or undefined at the top. */
export function parentKey(key: string): string | undefined {
  const at = key.lastIndexOf(SEP);
  return at < 0 ? undefined : key.slice(0, at);
}
