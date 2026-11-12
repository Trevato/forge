/**
 * An OpenAPI document read as a reference: operations grouped by area, each
 * with its parameters, body and responses as plain rows. The forge's own
 * document and an app's (which is data from outside, so every step here
 * tolerates a missing or odd shape) go through the same reading; the page
 * and the terminal render the result and never touch the document.
 */

export const METHODS = ["get", "put", "post", "delete", "patch"] as const;

export interface Field {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

export interface Param extends Field {
  readonly in: string;
}

export interface Reply {
  readonly status: string;
  readonly description: string;
  readonly fields: readonly Field[];
}

export interface Operation {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly summary: string;
  /** Whether it asks for a credential. */
  readonly auth: boolean;
  readonly params: readonly Param[];
  /** The JSON body's fields; absent when it takes none. */
  readonly body?: readonly Field[];
  readonly replies: readonly Reply[];
}

export interface Area {
  readonly name: string;
  readonly operations: readonly Operation[];
}

const MAX_OPERATIONS = 2000;
const MAX_FIELDS = 60;
const MAX_TEXT = 400;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined);
const text = (v: unknown): string => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");

/** A local `$ref` followed once; anything else is left as it is. */
function resolve(doc: Obj, node: Obj | undefined): Obj | undefined {
  const ref = node?.["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let at: unknown = doc;
  for (const part of ref.slice(2).split("/")) at = obj(at)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return obj(at);
}

/** A schema's type as one short word: `integer`, `string[]`, `a | b`, `enum(x, y)`. */
function typeOf(doc: Obj, schema: Obj | undefined): string {
  const s = resolve(doc, schema);
  if (s === undefined) return "any";
  if (Array.isArray(s["enum"])) return `enum(${s["enum"].slice(0, 8).map(String).join(", ")})`;
  const t = s["type"];
  if (t === "array") return `${typeOf(doc, obj(s["items"]))}[]`;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(String).join(" | ");
  const of = s["oneOf"] ?? s["anyOf"];
  if (Array.isArray(of)) return of.map((o) => typeOf(doc, obj(o))).join(" | ");
  return s["properties"] !== undefined ? "object" : "any";
}

/** An object schema's properties as rows. */
function fieldsOf(doc: Obj, schema: Obj | undefined): Field[] {
  const s = resolve(doc, schema);
  const props = obj(s?.["properties"]);
  if (props === undefined) return [];
  const required = Array.isArray(s?.["required"]) ? s["required"].map(String) : [];
  return Object.entries(props)
    .slice(0, MAX_FIELDS)
    .map(([name, p]) => ({ name: name.slice(0, 120), type: typeOf(doc, obj(p)), required: required.includes(name) }));
}

const jsonSchema = (doc: Obj, content: unknown): Obj | undefined => {
  const c = obj(resolve(doc, obj(content)));
  const json = obj(c?.["application/json"]) ?? Object.values(c ?? {}).map(obj).find((x) => x !== undefined);
  return obj(json?.["schema"]);
};

/** The area a path belongs to: its tag, else the first word after `/api/v1`. */
export function areaOf(path: string, tag?: string): string {
  if (tag !== undefined && tag !== "") return tag.slice(0, 60);
  const words = path.split("/").filter((w) => w !== "" && !w.startsWith("{"));
  const at = words[0] === "api" && /^v\d+$/.test(words[1] ?? "") ? 2 : 0;
  return words[at] ?? "root";
}

function operation(doc: Obj, path: string, method: string, op: Obj, shared: unknown[]): Operation {
  const params: Param[] = [...shared, ...(Array.isArray(op["parameters"]) ? op["parameters"] : [])]
    .map((p) => resolve(doc, obj(p)))
    .filter((p): p is Obj => p !== undefined && typeof p["name"] === "string")
    .slice(0, MAX_FIELDS)
    .map((p) => ({
      name: text(p["name"]),
      in: text(p["in"]) || "query",
      type: typeOf(doc, obj(p["schema"])),
      required: p["required"] === true || p["in"] === "path",
    }));
  const body = obj(resolve(doc, obj(op["requestBody"])));
  const replies = Object.entries(obj(op["responses"]) ?? {})
    .slice(0, 12)
    .map(([status, r]) => {
      const reply = resolve(doc, obj(r));
      return { status: status.slice(0, 8), description: text(reply?.["description"]), fields: fieldsOf(doc, jsonSchema(doc, reply?.["content"])) };
    });
  return {
    id: text(op["operationId"]) || `${method}${path}`,
    method,
    path,
    summary: text(op["summary"]) || text(op["description"]),
    auth: Array.isArray(op["security"]) ? op["security"].length > 0 : false,
    params,
    ...(body === undefined ? {} : { body: fieldsOf(doc, jsonSchema(doc, body["content"])) }),
    replies,
  };
}

/** Every operation of a document, grouped by area, areas and paths in order. */
export function reference(document: unknown): Area[] {
  const doc = obj(document);
  const paths = obj(doc?.["paths"]);
  if (doc === undefined || paths === undefined) return [];
  const areas = new Map<string, Operation[]>();
  let count = 0;
  for (const path of Object.keys(paths).sort()) {
    const item = obj(paths[path]);
    if (item === undefined || !path.startsWith("/")) continue;
    const shared = Array.isArray(item["parameters"]) ? item["parameters"] : [];
    for (const method of METHODS) {
      const op = obj(item[method]);
      if (op === undefined || count >= MAX_OPERATIONS) continue;
      count++;
      const tag = Array.isArray(op["tags"]) ? text(op["tags"][0]) : "";
      const name = areaOf(path, tag);
      const list = areas.get(name) ?? [];
      list.push(operation(doc, path.slice(0, 300), method, op, shared));
      areas.set(name, list);
    }
  }
  return [...areas].sort(([a], [b]) => a.localeCompare(b)).map(([name, operations]) => ({ name, operations }));
}

/** The operations whose method, path or summary holds every word of the query. */
export function narrow(areas: readonly Area[], query: string): Area[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [...areas];
  const out: Area[] = [];
  for (const a of areas) {
    const operations = a.operations.filter((o) => {
      const hay = `${o.method} ${o.path} ${o.summary} ${o.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (operations.length > 0) out.push({ name: a.name, operations });
  }
  return out;
}

/** Whether a GET can be sent as it is: no path parameter left to fill. */
export const runnable = (o: Operation): boolean => o.method === "get" && !o.path.includes("{");
