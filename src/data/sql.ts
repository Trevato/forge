/** What a read-only query may be: one SELECT or WITH statement, nothing else. */

/** The statement with comments and string literals blanked; identifiers stay. */
function skeleton(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += " ";
    } else if (c === "'") {
      i++;
      while (i < sql.length && sql[i] !== "'") i++;
      out += "''";
    } else out += c;
  }
  return out;
}

export function checkQuery(sql: string): "ok" | "empty" | "not_select" | "multiple" | "schema" {
  const s = skeleton(sql).trim().replace(/;+\s*$/, "").trim();
  if (s === "") return "empty";
  if (s.includes(";")) return "multiple";
  if (!/^(select|with)\b/i.test(s)) return "not_select";
  // `main.t` would step round the masking views that shadow `t`.
  if (/(^|[^\w])("main"|\[main\]|`main`|main)\s*\./i.test(s)) return "schema";
  return "ok";
}
