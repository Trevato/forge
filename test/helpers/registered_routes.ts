import { readdirSync, readFileSync } from "node:fs";

// "/api/v1/" is the same operation as "/api/v1": a trailing slash is not a second row.
export const norm = (path: string) => path.replace(/[:*]\w+/g, "{}").replace(/\{\w+\}/g, "{}").replace(/(?<=\w)\/$/, "");

/** Every file under src/http (and its route modules in src/http/api/) that registers routes. */
const files = () =>
  [...readdirSync(new URL("../../src/http/", import.meta.url)), ...readdirSync(new URL("../../src/http/api/", import.meta.url)).map((f) => `api/${f}`)]
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, src: readFileSync(new URL(`../../src/http/${f}`, import.meta.url), "utf8") }))
    .filter(({ src }) => src.includes("router.add("));

/**
 * The /api/v1 routes registered, as "METHOD /api/v1/…" with params as `{}`.
 * A path may be a string, a template literal or a constant of the same file
 * (`BROWSE`); `${NAME}` is resolved, and `${kind}` is the loop over issues and pulls. A `router.add` call this cannot read as
 * "METHOD", path throws, so a changed call style cannot shrink coverage.
 */
export const registered = (): string[] => {
  const found = new Set<string>();
  for (const { f, src } of files()) {
    const consts = new Map([...src.matchAll(/\bconst ([A-Z_]+) = "([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
    const resolve = (p: string) => p.replace(/\$\{([A-Z_]+)\}/g, (_, n) => consts.get(n) ?? `\${${n}}`);
    let read = 0;
    for (const m of src.matchAll(/router\.add\(\s*(?:"([A-Z]+)"|(method)),\s*(?:"([^"]*)"|`([^`]*)`|([A-Z_]+)\b)/g)) {
      read++;
      const path = resolve(m[3] ?? m[4] ?? consts.get(m[5]!) ?? "");
      if (!path.startsWith("/api/v1")) {
        if (!path.startsWith("/") && !m[3]) throw new Error(`${f}: router.add path not resolvable: ${JSON.stringify(path)} in ${JSON.stringify(m[0])}`);
        continue;
      }
      if (path.replace("${kind}", "").includes("${")) throw new Error(`${f}: router.add path not resolvable: ${JSON.stringify(path)} in ${JSON.stringify(m[0])}`);
      for (const method of m[1] ? [m[1]] : ["PUT", "DELETE"]) // `method` is the PUT/DELETE loop
        for (const v of path.includes("${kind}") ? ["issues", "pulls"] : [""]) found.add(`${method} ${norm(path.replace("${kind}", v))}`);
    }
    const calls = src.split("router.add(").length - 1;
    if (read !== calls) throw new Error(`${f}: ${calls} router.add calls but only ${read} readable`);
  }
  return [...found].sort();
};
