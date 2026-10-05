/**
 * Hollow work (#615): code that was merged and that nobody can reach.
 * `spawnForge` sat in `src/actions/` with six tests and no caller, and the
 * fleet graph was served at a path no page linked to.
 *
 * Two things are hollow, and `audit` names each in one line:
 *
 * - An exported function in `src/actions/` that no surface reaches. Reach
 *   starts at every declaration under `SURFACES` and at each module's own
 *   top-level statements, and follows the names a reached declaration
 *   mentions: to a declaration of the same file, or through an import to
 *   another file's. So an action called only by another action, or through
 *   `src/fleet/`, is reached, and one that only its tests call is not.
 * - A screen no page links to. A screen is a GET route whose path takes no
 *   parameter and whose handler can draw the page (`page`, `web/layout.ts`).
 *   It is linked when its path stands in a string of a module that a
 *   reachable page uses. The front door `/` and every route with a
 *   parameter are taken as reachable (a row's link is computed, which this
 *   cannot follow), and a screen joins them once it is linked — so a page
 *   that links only to itself, or two that link only to each other, are
 *   still orphans.
 *
 * Names are followed by spelling, not by scope, and a namespace or dynamic
 * import reaches the whole module: where it cannot tell, an action counts
 * as called.
 *
 * `ALLOWED` (`scripts/hollow-allow.ts`) is the hollow work main carries
 * today, each entry with the issue that owns it. Whatever is hollow and not
 * listed came with the change being judged: that is "what the diff adds",
 * answered in the forge's check directory, which has no `.git` to diff
 * against. An entry that is no longer hollow is a problem too, so the list
 * only shrinks.
 *
 *   bun scripts/hollow.ts     one line per problem; exits 1 if there is one
 *
 * `test/hollow.test.ts` runs the same audit over `src/`, so the gate goes
 * red on one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import ts from "typescript";
import { ALLOWED, type Allowed } from "./hollow-allow.ts";

/** Where a person or an agent comes in: routes and MCP tools, pages, the crew's workers, the CLI, the terminal. */
const SURFACES: readonly string[] = [
  "src/http/",
  "src/web/",
  "src/crew/",
  "src/cli/",
  "src/tui/",
];
/** "src/http, src/web, src/crew, src/cli or src/tui". */
const SURFACE_WORDS = SURFACES.map((surface) => surface.slice(0, -1))
  .join(", ")
  .replace(/, ([^,]*)$/, " or $1");
const ACTIONS = "src/actions/";
/** The function every full page is drawn through. */
const PAGE = "src/web/layout.ts#page";
const ALLOW_FILE = "scripts/hollow-allow.ts";

/** Source text by repository-relative path. */
export type Sources = ReadonlyMap<string, string>;

/** One export of one file; `*` is all of them. */
interface Origin {
  file: string;
  name: string;
}

interface Declaration {
  /** The names its text mentions. */
  refs: Set<string>;
  /** Declared as a function, or as a constant holding one. */
  fn: boolean;
}

interface Route {
  path: string;
  /** The names its handler mentions. */
  refs: Set<string>;
}

interface Module {
  /** Top-level declarations by the name the file knows them by. */
  declarations: Map<string, Declaration>;
  /** Exported name to where it is declared: here, or in the file it is re-exported from. */
  exports: Map<string, Origin>;
  /** `export * from` targets. */
  stars: string[];
  /** Local name to the export it was imported as. */
  imports: Map<string, Origin>;
  /** Every file this one imports a value from. */
  uses: Set<string>;
  /** The names its top-level statements mention: they run when it loads. */
  body: Set<string>;
  /** Files it imports whole, with `import()`. */
  whole: string[];
  /** `.add("GET", path, handler)` calls. */
  routes: Route[];
  /** String and template text; `continued` is the part after an interpolation. */
  strings: { text: string; continued: boolean }[];
}

type Modules = ReadonlyMap<string, Module>;

const has = (node: ts.Node, modifier: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === modifier);

/** Every name a binding declares: `a`, or each of `{ a, b: [c] }`. */
function bound(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bound(element.name) : [],
  );
}

/** One file, read into what it declares, imports, exports, routes and says. */
function read(file: string, text: string): Module {
  const mod: Module = {
    declarations: new Map(),
    exports: new Map(),
    stars: [],
    imports: new Map(),
    uses: new Set(),
    body: new Set(),
    whole: [],
    routes: [],
    strings: [],
  };
  const resolve = (spec: string): string | undefined => {
    if (!spec.startsWith(".")) return undefined;
    const target = posix.normalize(posix.join(posix.dirname(file), spec));
    mod.uses.add(target);
    return target;
  };

  /** The names `node` mentions go to `refs`; strings, routes and `import()` go to the module. */
  const walk = (node: ts.Node, refs: Set<string>): void => {
    if (ts.isIdentifier(node)) {
      // The name of a member, a parameter or a property is not a mention of
      // whatever else is spelled that way; `{ a }` is both.
      const parent = node.parent as ts.Node & {
        name?: ts.Node;
        propertyName?: ts.Node;
      };
      if (
        ts.isShorthandPropertyAssignment(parent) ||
        (parent.name !== node && parent.propertyName !== node)
      )
        refs.add(node.text);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node)
    )
      mod.strings.push({ text: node.text, continued: false });
    else if (ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      mod.strings.push({ text: node.text, continued: true });
    else if (ts.isCallExpression(node)) {
      const [first, second, ...rest] = node.arguments;
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      ) {
        const target = resolve(first.text);
        if (target !== undefined) mod.whole.push(target);
      }
      // `router.add("GET", path, handler)`: a route, and what its handler mentions.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "add" &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        first.text === "GET" &&
        second !== undefined &&
        ts.isStringLiteralLike(second) &&
        rest[0] !== undefined
      ) {
        const handler = new Set<string>();
        for (const argument of rest) walk(argument, handler);
        for (const ref of handler) refs.add(ref);
        mod.routes.push({ path: second.text, refs: handler });
        walk(node.expression, refs);
        return;
      }
    }
    ts.forEachChild(node, (child) => walk(child, refs));
  };

  const define = (
    names: readonly string[],
    node: ts.Node,
    fn: boolean,
    exported: boolean,
  ): void => {
    const refs = new Set<string>();
    walk(node, refs);
    for (const name of names) {
      // Overloads and merged declarations share one entry.
      const declaration = mod.declarations.get(name) ?? { refs, fn };
      mod.declarations.set(name, declaration);
      for (const ref of refs) declaration.refs.add(ref);
      declaration.fn ||= fn;
      if (exported) mod.exports.set(name, { file, name });
    }
  };

  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (clause?.isTypeOnly) continue;
      const target = resolve(statement.moduleSpecifier.text);
      if (target === undefined || clause === undefined) continue;
      if (clause.name)
        mod.imports.set(clause.name.text, { file: target, name: "default" });
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings))
        mod.imports.set(bindings.name.text, { file: target, name: "*" });
      else
        for (const element of bindings.elements)
          if (!element.isTypeOnly)
            mod.imports.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
            });
    } else if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const from = statement.moduleSpecifier;
      const target =
        from !== undefined && ts.isStringLiteral(from)
          ? resolve(from.text)
          : undefined;
      // Re-exporting a package is nothing of ours.
      if (from !== undefined && target === undefined) continue;
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (target !== undefined) mod.stars.push(target);
      } else if (ts.isNamespaceExport(clause)) {
        if (target !== undefined)
          mod.exports.set(clause.name.text, { file: target, name: "*" });
      } else
        for (const element of clause.elements)
          if (!element.isTypeOnly)
            mod.exports.set(element.name.text, {
              file: target ?? file,
              name: (element.propertyName ?? element.name).text,
            });
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        define(
          bound(declaration.name),
          declaration,
          value !== undefined &&
            (ts.isArrowFunction(value) || ts.isFunctionExpression(value)),
          has(statement, ts.SyntaxKind.ExportKeyword),
        );
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name !== undefined &&
      ts.isIdentifier(statement.name)
    ) {
      const name = statement.name.text;
      const byDefault = has(statement, ts.SyntaxKind.DefaultKeyword);
      define(
        [name],
        statement,
        ts.isFunctionDeclaration(statement),
        has(statement, ts.SyntaxKind.ExportKeyword) && !byDefault,
      );
      if (byDefault) mod.exports.set("default", { file, name });
    } else walk(statement, mod.body);
  }
  return mod;
}

/** The declarations the export `name` of `file` leads to, as `file#name`; `*` is every export. */
function exportedAs(
  modules: Modules,
  file: string,
  name: string,
  seen = new Set<string>(),
): string[] {
  const mod = modules.get(file);
  const key = `${file}#${name}`;
  if (mod === undefined || seen.has(key)) return [];
  seen.add(key);
  if (name === "*")
    return [
      ...[...mod.exports.keys()].flatMap((each) =>
        exportedAs(modules, file, each, seen),
      ),
      ...mod.stars.flatMap((star) => exportedAs(modules, star, "*", seen)),
    ];
  const origin = mod.exports.get(name);
  if (origin === undefined)
    return mod.stars.flatMap((star) => exportedAs(modules, star, name, seen));
  if (origin.file !== file)
    return exportedAs(modules, origin.file, origin.name, seen);
  return mod.declarations.has(origin.name) ? [`${file}#${origin.name}`] : [];
}

/** The declarations a name mentioned in `file` stands for: the file's own, or what its import of that name leads to. */
function meant(modules: Modules, file: string, mention: string): string[] {
  const mod = modules.get(file);
  if (mod === undefined) return [];
  const origin = mod.imports.get(mention);
  return [
    ...(mod.declarations.has(mention) ? [`${file}#${mention}`] : []),
    ...(origin === undefined
      ? []
      : exportedAs(modules, origin.file, origin.name)),
  ];
}

type Edges = ReadonlyMap<string, readonly string[]>;

/** Each declaration, as `file#name`, to the declarations its text mentions. */
function graph(modules: Modules): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const [file, mod] of modules)
    for (const [name, declaration] of mod.declarations)
      edges.set(
        `${file}#${name}`,
        [...declaration.refs].flatMap((mention) =>
          meant(modules, file, mention),
        ),
      );
  return edges;
}

/** Everything `edges` leads to from `starts`, the starts included. */
function reach(edges: Edges, starts: Iterable<string>): Set<string> {
  const reached = new Set<string>();
  const todo = [...starts];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    if (reached.has(at)) continue;
    reached.add(at);
    for (const next of edges.get(at) ?? []) todo.push(next);
  }
  return reached;
}

/** Something hollow: what `ALLOWED` calls it, and the line that says so. */
export interface Hollow {
  id: string;
  line: string;
}

/** Exported functions in `src/actions/` that no surface reaches, as `file#name`. */
function hollowActions(modules: Modules, edges: Edges): Hollow[] {
  const starts: string[] = [];
  for (const [file, mod] of modules) {
    for (const mention of mod.body)
      starts.push(...meant(modules, file, mention));
    for (const target of mod.whole)
      starts.push(...exportedAs(modules, target, "*"));
    if (SURFACES.some((surface) => file.startsWith(surface)))
      for (const name of mod.declarations.keys())
        starts.push(`${file}#${name}`);
  }
  const reached = reach(edges, starts);
  const found: Hollow[] = [];
  for (const [file, mod] of modules) {
    if (!file.startsWith(ACTIONS)) continue;
    for (const [name, origin] of mod.exports) {
      if (origin.file !== file) continue;
      if (mod.declarations.get(origin.name)?.fn !== true) continue;
      if (reached.has(`${file}#${origin.name}`)) continue;
      const id = `${file}#${name}`;
      found.push({
        id,
        line: `${id} is exported and nothing under ${SURFACE_WORDS} reaches it: call it from a route, a page or an MCP tool, or list it in ALLOWED (${ALLOW_FILE}) with the issue that owns it`,
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/** A character a path goes on with. */
const PATH = /[\w\-./]/;

/** Whether `path` stands whole in one of `strings`: not inside a longer path, not after an interpolation. */
function says(strings: Module["strings"], path: string): boolean {
  for (const { text, continued } of strings)
    for (
      let at = text.indexOf(path);
      at !== -1;
      at = text.indexOf(path, at + 1)
    ) {
      const before = at === 0 ? !continued : !PATH.test(text[at - 1] ?? "");
      const after = !PATH.test(text[at + path.length] ?? "");
      if (before && after) return true;
    }
  return false;
}

/** Screens no reachable page links to, as `GET path`. */
function orphanScreens(modules: Modules, edges: Edges): Hollow[] {
  // Every declaration that can end in drawing the page.
  const back = new Map<string, string[]>();
  for (const [from, mentioned] of edges)
    for (const to of mentioned) {
      const list = back.get(to) ?? [];
      back.set(to, list);
      list.push(from);
    }
  const drawers = reach(back, [PAGE]);

  type Page = {
    path: string;
    /** The files its handler is written in. */
    files: Set<string>;
    /** Its path takes no parameter. */
    fixed: boolean;
    /** Its handler can draw the page. */
    draws: boolean;
  };
  const pages: Page[] = [];
  for (const [file, mod] of modules)
    for (const route of mod.routes) {
      const files = new Set<string>();
      for (const mention of route.refs) {
        const origin = mod.imports.get(mention);
        if (origin !== undefined) files.add(origin.file);
      }
      pages.push({
        path: route.path,
        files,
        fixed: !/[:*]/.test(route.path),
        draws: [...route.refs].some((mention) =>
          meant(modules, file, mention).some((id) => drawers.has(id)),
        ),
      });
    }
  const screens = pages.filter((page) => page.fixed && page.draws);

  // The files of pages a person can get to: the front door's, and those of
  // every page whose path takes a parameter.
  const linked = new Set(pages.filter((page) => page.path === "/"));
  const open = new Set<string>();
  for (const page of pages)
    if (linked.has(page) || (page.draws && !page.fixed))
      for (const file of page.files) open.add(file);
  for (;;) {
    // Everything a reachable page is drawn from: its file and what that
    // uses. Not through a file that registers routes: it imports every page,
    // and being routed is not being linked.
    const drawn = new Set<string>();
    const todo = [...open];
    for (let file = todo.pop(); file !== undefined; file = todo.pop()) {
      const mod = modules.get(file);
      if (mod === undefined || mod.routes.length > 0 || drawn.has(file))
        continue;
      drawn.add(file);
      for (const used of mod.uses) todo.push(used);
    }
    const found = screens.filter(
      (page) =>
        !linked.has(page) &&
        [...drawn].some((file) =>
          says(modules.get(file)?.strings ?? [], page.path),
        ),
    );
    if (found.length === 0) break;
    for (const page of found) {
      linked.add(page);
      for (const file of page.files) open.add(file);
    }
  }

  return screens
    .filter((page) => !linked.has(page))
    .map((page) => {
      const id = `GET ${page.path}`;
      return {
        id,
        line: `${id} (${[...page.files].sort().join(", ")}) is a screen no page links to: link it from a page a person can get to, or list it in ALLOWED (${ALLOW_FILE}) with the issue that owns it`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Every hollow action and orphan screen in `sources`. */
export function hollow(sources: Sources): Hollow[] {
  const modules = new Map<string, Module>();
  for (const [file, text] of sources) modules.set(file, read(file, text));
  const edges = graph(modules);
  return [...hollowActions(modules, edges), ...orphanScreens(modules, edges)];
}

/**
 * Everything wrong, one line per problem: hollow work `allowed` does not
 * list, and entries of `allowed` that are stale, doubled or unowned.
 */
export function audit(
  sources: Sources,
  allowed: readonly Allowed[] = ALLOWED,
): string[] {
  const all = hollow(sources);
  const found = new Set(all.map((h) => h.id));
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const { orphan, reason, issue } of allowed) {
    if (listed.has(orphan)) problems.push(`${orphan} is in ALLOWED twice`);
    listed.add(orphan);
    if (!found.has(orphan))
      problems.push(
        `${orphan} is in ALLOWED but is not hollow: remove the entry`,
      );
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(`${orphan} is allowed with no reason`);
    if (!Number.isInteger(issue) || issue <= 0)
      problems.push(`${orphan} is allowed with no issue number`);
  }
  for (const { id, line } of all) if (!listed.has(id)) problems.push(line);
  return problems;
}

/** Every `.ts` file under `root`/src, by repository-relative path. */
export function readSources(root: string): Map<string, string> {
  const sources = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(posix.join(root, dir), {
      withFileTypes: true,
    })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".ts"))
        sources.set(path, readFileSync(posix.join(root, path), "utf8"));
    }
  };
  walk("src");
  return sources;
}

if (import.meta.main) {
  const problems = audit(readSources(new URL("..", import.meta.url).pathname));
  for (const problem of problems) console.error(`hollow: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    `hollow: none beyond the ${ALLOWED.length} listed in ${ALLOW_FILE}`,
  );
}
