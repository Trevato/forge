/**
 * What the billing webhook can reach that deletes (#11392, part of #11140:
 * losing someone's work is never the penalty for not paying).
 *
 * `destroyReach(root, entry)` follows calls, not whole files: from every
 * top-level unit (function, const, class) of the entry file, each identifier
 * that names a local unit or an imported one pulls that unit in, through
 * value imports, `import * as`, re-exports and `import()`. Whole-file
 * reachability would reach all of the forge through `app.ts` and say
 * nothing. A reachable unit that calls `rm`/`rmSync`/`unlink`/`unlinkSync`/
 * `rmdir`/`rmdirSync` at all (bare, as a member such as `fs.promises.rm(`, under
 * an import alias, over several lines, on a path held in a variable), or names
 * a removal action (`SINKS`), or names the event `repo.deleted`, is a finding:
 * `file:line: text`, with the chain of units that led there. The path is never
 * judged: only a unit on `ALLOWED_REMOVALS`, with its reason, may remove.
 *
 * Approximation, stated: units are cut at column-0 declarations (a file with
 * an indented top-level declaration is a finding, see `layoutMisses`); a
 * method call through an object (`app.x.y()`) is followed by method name
 * within files the caller imports; a class is one unit. A removal by spawning
 * a process (a spawn of `rm`) is a finding too. Plain data in, plain
 * data out.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Removal actions by name: the child-removal action and the directory deleters. */
export const SINKS: readonly string[] = ["removeForge", "removeApp", "removeEnv", "deleteRepoDir", "deleteApp", "deleteRepo"];

/**
 * Units the walk does not enter, each with why. A stop is not trusted by its
 * name: when a reachable unit refers to it, that unit must be in `from`
 * (`file:unit`), so a new path to it from the webhook is a finding.
 * - `AppsRuntime.start`: the walk matches a method call by name, so a cell's
 *   `.start(` looks like the runtime's. The test reads `settleCell` and checks
 *   it names the cell registry and never the runtime.
 * - `AppsRuntime.onEvent`: entered by the bus, not by a call. It tears an app
 *   down only on `repo.deleted`; a reachable unit that names that event is a
 *   finding, so the webhook appends none. Nothing may call it directly.
 * - `AppsRuntime.reconcileApp`: boots a forge's environments and removes those
 *   of closed pulls. Only the units in `from` may reach it, and they act on a
 *   forge the webhook has just made.
 */
export const STOPS: readonly { unit: string; why: string; from: readonly string[] }[] = [
  {
    unit: "AppsRuntime.start",
    why: "the forge's own boot, and its prune of app data with no row; `cells.start(ledger)` in `settleCell` is `CellChildren.start`, a cell's; `startChildApps` starts the runtime of the child just made, over its own empty data",
    from: ["src/spawn/host.ts:settleCell", "src/spawn/child-apps.ts:startChildApps"],
  },
  { unit: "AppsRuntime.onEvent", why: "entered by the bus; the webhook appends no repo.deleted", from: [] },
  { unit: "AppsRuntime.reconcileApp", why: "boot tidy of a forge the webhook has just made, which holds no environments", from: [] },
];

const unitsOn = (why: string, units: string[]): { unit: string; why: string }[] => units.map((unit) => ({ unit, why }));

/**
 * Reachable units that may remove a file, each with why. A path is never
 * judged: a unit is here because a person read it. Most are reached because
 * making a forge boots it (`makeForge` -> `bootHostedChild`), and boot tidies
 * its own scratch. A unit that grows a second removal is still allowed here, so
 * read the whole unit when you add or change one; `test/billing-never-deletes
 * .test.ts` fails when an entry no longer removes anything (a stale reason).
 */
export const ALLOWED_REMOVALS: readonly { unit: string; why: string }[] = [
  ...unitsOn("scratch under the checks root, per run or commit (checkouts, caches, locks, the install cache): never a forge's or an app's directory", [
    "src/checks/service.ts:startChecks",
    "src/checks/service.ts:removeRunDir",
    "src/checks/cache.ts:restoreCache",
    "src/checks/cache.ts:keepCache",
    "src/checks/impact-store.ts:seedImpact",
    "src/checks/install.ts:prefillInstallCache",
    "src/checks/install.ts:holdFile",
    "src/checks/install_evict.ts:evictInstallCache",
    "src/apps/checkout.ts:exportTree",
  ]),
  { unit: "src/core/repos.ts:rowOrUndo", why: "removes the directory git has just made for the repository being created, when its row is refused" },
  { unit: "src/git/write.ts:commitFiles", why: "removes its own temporary index file" },
  { unit: "src/git/repos.ts:detachFork", why: "removes the alternates file of the fork just made" },
  { unit: "src/git/env.ts:trustedCaBundle", why: "removes the process's own temporary CA bundle at exit" },
  { unit: "src/apps/contain.ts:openCell", why: "clears the cell's socket directory before the cell opens" },
  { unit: "src/apps/cgroup.ts:removeDir", why: "removes an empty cgroup directory" },
  { unit: "src/spawn/own_code.ts:checkout", why: "removes a half-made export of the forge's own code, keyed by commit" },
  { unit: "src/spawn/own_code.ts:recordGood", why: "removes exports of the forge's own code for other commits than the good one" },
  { unit: "src/web/asset.ts:prune", why: "removes cached page scripts older than their keep time" },
];

const REMOVERS = ["rmSync", "rmdirSync", "unlinkSync", "rm", "rmdir", "unlink"];
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
/** A removal spawned as a process, or a shell. */
const SPAWNED = /\b(?:Bun\.spawn(?:Sync)?\(\s*\[?\s*["'`](?:rm|unlink|rmdir|sh|bash)["'`]|Bun\.\$\s*`\s*rm\b|child_process|execSync|execFileSync)/;
const EVENT = /["'`]repo\.deleted["'`]/;
const METHOD = /^ {2}(?:(?:public|private|protected|static|async|override|get|set)\s+)*([A-Za-z_$#][\w$]*)\s*[(<]/;
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/;

interface Unit { file: string; name: string; start: number; text: string; methods?: Unit[] }
interface Module {
  touches: Set<string>;
  units: Map<string, Unit>;
  imports: Map<string, { from: string; name: string }>;
  spaces: Map<string, string>;
  reexports: string[];
  /** Local names that mean a file removal in this module (`import { rmSync as r } from "node:fs"`). */
  removers: Set<string>;
  /** Every identifier in the file: a class is a candidate for a method call only where it is named. */
  words: Set<string>;
}

const resolve = (root: string, from: string, spec: string): string | undefined => {
  const base = normalize(join(dirname(from), spec));
  for (const c of [base, `${base}.ts`, join(base, "index.ts")]) {
    const full = join(root, c);
    if (existsSync(full) && statSync(full).isFile()) return c;
  }
  return undefined;
};

/** The text with comments blanked, newlines kept, so a line number still means the same line. */
const stripComments = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(?<![:"'`\\])\/\/[^\n]*/g, (c) => " ".repeat(c.length));

function parse(root: string, file: string): Module {
  const text = readFileSync(join(root, file), "utf8");
  const lines = text.split("\n");
  const units = new Map<string, Unit>();
  const imports = new Map<string, { from: string; name: string }>();
  const spaces = new Map<string, string>();
  const reexports: string[] = [];
  const touches = new Set<string>();
  const removers = new Set<string>();
  for (const m of text.matchAll(/^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)"/gms)) {
    const clause = m[3]!.trim();
    if (!m[4]!.startsWith(".")) {
      if (FS_MODULE.test(m[4]!))
        for (const part of (clause.match(/\{([^}]*)\}/s)?.[1] ?? "").split(",")) {
          const [name, local] = part.trim().split(/\s+as\s+/);
          if (name && REMOVERS.includes(name)) removers.add((local ?? name).trim());
        }
      continue;
    }
    const target = resolve(root, file, m[4]!);
    if (target === undefined) continue;
    touches.add(target);
    if (m[2] !== undefined) continue;
    if (m[1] === "export") reexports.push(target);
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) spaces.set(ns[1]!, target);
    for (const part of (clause.match(/\{([^}]*)\}/s)?.[1] ?? "").split(",")) {
      const p = part.trim().replace(/^type\s+.*/, "");
      if (p === "") continue;
      const [name, local] = p.split(/\s+as\s+/);
      imports.set((local ?? name)!.trim(), { from: target, name: name!.trim() });
    }
    const def = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    if (def && !clause.startsWith("{")) imports.set(def[1]!, { from: target, name: "default" });
  }
  for (const m of text.matchAll(/^export\s+\*\s+from\s+"(\.[^"]+)"/gm)) {
    const target = resolve(root, file, m[1]!);
    if (target !== undefined) {
      touches.add(target);
      reexports.push(target);
    }
  }
  for (const m of text.matchAll(/import\(\s*"(\.[^"]+)"\s*\)/g)) {
    const target = resolve(root, file, m[1]!);
    if (target !== undefined) {
      touches.add(target);
      reexports.push(target);
    }
  }
  let open: Unit | undefined;
  let owner: Unit | undefined;
  lines.forEach((line, i) => {
    const d = DECL.exec(line);
    if (d) {
      open = { file, name: d[1]!, start: i + 1, text: "" };
      units.set(open.name, open);
      owner = /\bclass\s/.test(line) ? open : undefined;
    }
    if (/^(import|export\s+(type|interface)|type|interface|export\s+\{)\b/.test(line) && !d) open = owner = undefined;
    const meth = owner && !d ? METHOD.exec(line) : null;
    if (owner && meth && meth[1] !== "constructor") {
      open = { file, name: `${owner.name}.${meth[1]}`, start: i + 1, text: "" };
      (owner.methods ??= []).push(open);
    } else if (owner && !d && /^\S/.test(line)) open = owner;
    if (open) open.text += `${line}\n`;
  });
  return { touches, units, imports, spaces, reexports, removers, words: new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []) };
}

/**
 * Lines a column-0 cut would hide: a declaration, import or export that is
 * indented. A file with any is not read right, and the walk says so rather
 * than pass over its code.
 */
export function layoutMisses(root: string, file: string): string[] {
  const out: string[] = [];
  stripComments(readFileSync(join(root, file), "utf8"))
    .split("\n")
    .forEach((line, i) => {
      if (/^[ \t]+(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|\{)|import\s+[\w{*"])/.test(line) && !/^[ \t]*\/?\*/.test(line))
        out.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  return out;
}

/** The units of one file by name, as the walk cut them; for the test that a parse miss is loud. */
export function unitsOf(root: string, file: string): { name: string; start: number; text: string }[] {
  return [...parse(root, file).units.values()].map(({ name, start, text }) => ({ name, start, text }));
}

/**
 * Every finding reachable from the units of `entry` (repo-relative, under
 * `root`). `allowed` are the units that may remove a file, each with why.
 */
export function destroyReach(root: string, entry: string, allowed: readonly { unit: string; why: string }[] = ALLOWED_REMOVALS): string[] {
  const mods = new Map<string, Module>();
  const mod = (f: string): Module => {
    let m = mods.get(f);
    if (!m) mods.set(f, (m = parse(root, f)));
    return m;
  };
  const found = (f: string, name: string, seen = new Set<string>()): Unit | undefined => {
    if (seen.has(f)) return undefined;
    seen.add(f);
    const m = mod(f);
    const u = m.units.get(name);
    if (u) return u;
    for (const r of m.reexports) {
      const hit = found(r, name, seen);
      if (hit) return hit;
    }
    return undefined;
  };
  const out: string[] = [];
  const via = new Map<Unit, Unit | undefined>();
  const queue: Unit[] = [];
  const touchesFile = (from: string, to: string): boolean => mod(from).touches.has(to);
  const methods = new Map<string, Unit[]>();
  const wanted = new Map<string, Unit[]>();
  const chainOf = (u: Unit): string => {
    const names: string[] = [];
    for (let c: Unit | undefined = u; c; c = via.get(c)) names.unshift(`${c.file}:${c.name}`);
    return names.join(" -> ");
  };
  /** A method is called from a unit only where its file is the unit's or imported by it, and its class is named there. */
  const candidate = (caller: Unit, method: Unit): boolean =>
    (method.file === caller.file || touchesFile(caller.file, method.file)) && mod(caller.file).words.has(method.name.slice(0, method.name.indexOf(".")));
  const stopped = new Set<string>();
  const add = (u: Unit | undefined, from: Unit | undefined) => {
    if (!u) return;
    const stop = from && STOPS.find((x) => x.unit === u.name);
    if (stop) {
      const key = `${from.file}:${from.name}>${u.name}`;
      if (!stop.from.includes(`${from.file}:${from.name}`) && !stopped.has(key)) {
        stopped.add(key);
        out.push(`${from.file}:${from.start}: reaches ${u.name}, which a webhook path may not enter from here (${stop.why})  [${chainOf(from)}]`);
      }
      return;
    }
    if (via.has(u)) return;
    via.set(u, from);
    queue.push(u);
    for (const m of u.methods ?? []) {
      const name = m.name.slice(m.name.indexOf(".") + 1);
      methods.set(name, [...(methods.get(name) ?? []), m]);
      for (const c of wanted.get(name) ?? []) if (candidate(c, m)) add(m, c);
    }
  };
  const entryMod = mod(entry);
  if (entryMod.units.size === 0) return [`${entry}: no unit parsed, so nothing was walked`];
  for (const miss of layoutMisses(root, entry)) out.push(`${miss}  [indented top-level code hides from the walk]`);
  for (const u of entryMod.units.values()) add(u, undefined);
  const flagged = new Set<string>();
  while (queue.length) {
    const u = queue.shift()!;
    const m = mod(u.file);
    if (!flagged.has(u.file)) {
      flagged.add(u.file);
      if (u.file !== entry) for (const miss of layoutMisses(root, u.file)) out.push(`${miss}  [indented top-level code hides from the walk]`);
    }
    const code = stripComments(u.text);
    const mayRemove = allowed.some((x) => x.unit === `${u.file}:${u.name}`);
    const local = new Set(m.removers);
    for (const a of code.matchAll(/\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*:\s*([A-Za-z_$][\w$]*)/g)) local.add(a[2]!);
    for (const a of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)*(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*[;,\n)]/g)) local.add(a[1]!);
    const names = [...new Set([...REMOVERS, ...local])].join("|");
    const call = new RegExp(`(?<![\\w$.])(?:${names})\\s*\\(|\\.\\s*(?:${REMOVERS.join("|")})\\s*\\(|\\?\\.\\s*(?:${REMOVERS.join("|")})\\s*\\(`, "g");
    const named = new RegExp(`\\b(?:${SINKS.join("|")})\\b`);
    const lineOf = (at: number): number => code.slice(0, at).split("\n").length - 1;
    const report = (at: number, why: string) => {
      const i = lineOf(at);
      out.push(`${u.file}:${u.start + i}: ${u.text.split("\n")[i]!.trim()}  [${why}; ${chainOf(u)}]`);
    };
    if (!mayRemove) for (const c of code.matchAll(call)) report(c.index!, "removes a file");
    code.split("\n").forEach((line, i) => {
      if (named.test(line) || SPAWNED.test(line) || EVENT.test(line)) report(code.split("\n").slice(0, i).join("\n").length + (i ? 1 : 0), "names a removal");
    });
    for (const id of new Set(u.text.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const localUnit = m.units.get(id);
      if (localUnit) add(localUnit, u);
      const imp = m.imports.get(id);
      if (imp) add(found(imp.from, imp.name), u);
    }
    for (const hit of u.text.matchAll(/\.#?([A-Za-z_$][\w$]*)/g)) {
      wanted.set(hit[1]!, [...(wanted.get(hit[1]!) ?? []), u]);
      for (const mm of methods.get(hit[1]!) ?? []) if (candidate(u, mm)) add(mm, u);
    }
    for (const [ns, target] of m.spaces)
      for (const hit of u.text.matchAll(new RegExp(`\\b${ns}\\.([\\w$]+)`, "g"))) add(found(target, hit[1]!), u);
    for (const target of m.reexports) if (u.text.includes("import(")) for (const x of mod(target).units.values()) add(x, u);
  }
  return out;
}

/** The webhook route's file: where the walk starts. */
export const WEBHOOK_ENTRY = "src/http/stripe_hook.ts";

/** Gate form: one line per finding; a missing webhook is a finding, never a pass. */
export function destroyReachRefusal(root = "."): string[] {
  if (!existsSync(join(root, WEBHOOK_ENTRY))) return [`${WEBHOOK_ENTRY} is not there: the walk has nothing to start from; if the webhook moved, change WEBHOOK_ENTRY in src/kernel/destroy_reach.ts`];
  return destroyReach(root, WEBHOOK_ENTRY).map((f) => `the billing webhook reaches a deletion: ${f}`);
}
