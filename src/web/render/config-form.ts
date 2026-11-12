/**
 * A JSON document as form fields, and a submitted form back as a document.
 *
 * Every field is named for the JSON pointer of its value: `v/servers/0/port`
 * carries text, `j/mode` carries a JSON value (an enum's select), and a
 * boolean is a checkbox whose absence means false. The document's shape
 * travels beside them in a hidden `doc`, so a plain form POST — no script —
 * can add, remove and reorder cards: each of those is a submit button named
 * `op` (`opValue`), applied by `applyOp` before the form is drawn again.
 *
 * Without a schema a field's control comes from its value; with one, from
 * the schema too: an enum is a select, `description` is the help text, and
 * `required`, `minimum`, `maximum` and `pattern` are the input's own
 * attributes, so a browser checks them inline before the form is sent.
 */

import { html, raw, when, type Html } from "../html.ts";
import { btn, field } from "../ui.ts";
import {
  blankLike,
  fromPlain,
  pointer,
  splitPointer,
  updateAt,
  type Json,
} from "./json-doc.ts";
import { isJsonNumber, schemaAt, type FoundSchema, type Schema } from "./json-schema.ts";

/** More values than this and the form is no help: the source editor is. */
export const MAX_FIELDS = 2_000;

/** How many values (leaves) a document has, for `MAX_FIELDS`. */
export function countFields(doc: Json): number {
  if (doc.t === "array") return doc.items.reduce((n, v) => n + countFields(v), 1);
  if (doc.t === "object") return doc.entries.reduce((n, [, v]) => n + countFields(v), 1);
  return 1;
}

export interface FieldsOptions {
  readonly found?: FoundSchema | undefined;
  /** Messages by pointer, each drawn under its field. */
  readonly errors?: ReadonlyMap<string, string>;
  /** What was typed into a field that could not hold it (a bad number). */
  readonly typed?: ReadonlyMap<string, string>;
  /** Draw the values only: no inputs that submit, no buttons. */
  readonly readonly?: boolean;
}

export type Op = "add" | "remove" | "up" | "down" | "key";

/** A structural button's value: which change, at which pointer. */
export const opValue = (op: Op, at: string, key?: string): string =>
  JSON.stringify(key === undefined ? [op, at] : [op, at, key]);

const isScalar = (v: Json): boolean => v.t !== "array" && v.t !== "object";

const typeList = (s: Schema | undefined): readonly string[] =>
  s?.type === undefined ? [] : typeof s.type === "string" ? [s.type] : s.type;

/** What a new value under schema `s` starts as, shaped like `like` when the schema is silent. */
function blankFor(s: Schema | undefined, like: Json | undefined): Json {
  if (s?.default !== undefined) return fromPlain(s.default);
  if (Array.isArray(s?.enum) && s.enum.length > 0) return fromPlain(s.enum[0]);
  const t = typeList(s)[0];
  if (t === "string") return { t: "string", v: "" };
  if (t === "number" || t === "integer") return { t: "number", v: "0" };
  if (t === "boolean") return { t: "boolean", v: false };
  if (t === "array") return { t: "array", items: [] };
  if (t === "object") {
    const props = s?.properties ?? {};
    const keys = Array.isArray(s?.required) ? s.required.filter((k) => typeof k === "string") : [];
    return { t: "object", entries: keys.map((k) => [k, blankFor(props[k], undefined)] as const) };
  }
  return blankLike(like);
}

const parentOf = (p: string): { parent: string; index: number } | undefined => {
  const cut = p.lastIndexOf("/");
  const tail = p.slice(cut + 1);
  return cut < 0 || !/^(0|[1-9]\d*)$/.test(tail) ? undefined : { parent: p.slice(0, cut), index: Number(tail) };
};

/** One structural change to the document; anything unrecognised changes nothing. */
export function applyOp(doc: Json, raw: string, found?: FoundSchema): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return doc;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return doc;
  const [op, at, key] = parsed as [string, string, unknown];
  if (splitPointer(at) === undefined) return doc;
  if (op === "add")
    return updateAt(doc, at, (arr) =>
      arr.t !== "array"
        ? arr
        : { t: "array", items: [...arr.items, blankFor(schemaAt(found, pointer(at, arr.items.length)), arr.items.at(-1))] },
    );
  if (op === "key" && typeof key === "string" && key !== "")
    return updateAt(doc, at, (obj) =>
      obj.t !== "object" || obj.entries.some(([k]) => k === key)
        ? obj
        : { t: "object", entries: [...obj.entries, [key, blankFor(schemaAt(found, pointer(at, key)), undefined)] as const] },
    );
  const place = parentOf(at);
  if (place === undefined) return doc;
  const { parent, index } = place;
  return updateAt(doc, parent, (arr) => {
    if (arr.t !== "array" || index >= arr.items.length) return arr;
    const items = [...arr.items];
    if (op === "remove") items.splice(index, 1);
    else if (op === "up" || op === "down") {
      const to = op === "up" ? index - 1 : index + 1;
      if (to < 0 || to >= items.length) return arr;
      [items[index], items[to]] = [items[to]!, items[index]!];
    } else return arr;
    return { t: "array", items };
  });
}

/**
 * The document with the form's values written into it. A number that is not
 * one keeps the old value and comes back in `typed` with an error, so the
 * form can be drawn again with the person's text still in it.
 */
export function readValues(
  doc: Json,
  get: (name: string) => string | undefined,
): { doc: Json; errors: Map<string, string>; typed: Map<string, string> } {
  const errors = new Map<string, string>();
  const typed = new Map<string, string>();
  const walk = (v: Json, p: string): Json => {
    if (v.t === "object") return { t: "object", entries: v.entries.map(([k, x]) => [k, walk(x, pointer(p, k))] as const) };
    if (v.t === "array") return { t: "array", items: v.items.map((x, i) => walk(x, pointer(p, i))) };
    const chosen = get(`j${p}`);
    if (chosen !== undefined) {
      try {
        return fromPlain(JSON.parse(chosen));
      } catch {
        return v;
      }
    }
    const text = get(`v${p}`);
    if (v.t === "boolean") return { t: "boolean", v: text === "true" };
    if (text === undefined || v.t === "null") return v;
    if (v.t === "string") return { t: "string", v: text.replace(/\r\n/g, "\n") };
    const n = text.trim();
    if (isJsonNumber(n)) return { t: "number", v: n };
    errors.set(p, "Must be a number.");
    typed.set(p, text);
    return v;
  };
  return { doc: walk(doc, ""), errors, typed };
}

// ---- drawing ----

/** The last segment of a pointer, as a field's label. */
const labelOf = (p: string): string => splitPointer(p)?.at(-1) ?? "";

let fieldSerial = 0;

const description = (s: Schema | undefined): string | undefined =>
  typeof s?.description === "string" && s.description !== "" ? s.description : undefined;

/**
 * One scalar value as `field()`: its label, control, help and error. The
 * control follows the schema when it says (an enum is a select), else the
 * value (a boolean is a checkbox, a number a number input).
 */
function scalarField(
  v: Json,
  p: string,
  s: Schema | undefined,
  o: FieldsOptions,
  f: { label: string; required: boolean; labelHidden?: boolean; after?: Html | null },
): Html {
  const off = o.readonly === true;
  const help = description(s);
  const error = o.errors?.get(p);
  const shared = {
    id: `cf-${++fieldSerial}`,
    label: f.required && !off ? `${f.label} (required)` : f.label,
    ...(help === undefined ? {} : { hint: help }),
    ...(error === undefined ? {} : { error }),
    ...(f.labelHidden ? { labelHidden: true } : {}),
    ...(f.after ? { after: f.after } : {}),
  };
  if (Array.isArray(s?.enum) && s.enum.length > 0) {
    const current = JSON.stringify(v.t === "number" ? Number(v.v) : v.t === "string" || v.t === "boolean" ? v.v : null);
    const choices = s.enum.map((e) => ({ value: JSON.stringify(e), label: typeof e === "string" ? e : JSON.stringify(e) }));
    const options = [
      ...(choices.some((c) => c.value === current) ? [] : [{ value: current, label: current }]),
      ...choices,
    ].map((c) => ({ ...c, selected: c.value === current }));
    return field({ ...shared, name: `j${p}`, type: "select", options, ...(off ? { disabled: true } : {}) });
  }
  if (v.t === "boolean")
    return field({ ...shared, name: `v${p}`, type: "checkbox", value: "true", checked: v.v, ...(off ? { disabled: true } : {}) });
  if (v.t === "null") return field({ ...shared, name: `v${p}`, value: "null", readonly: true, mono: true });
  if (v.t === "number")
    return field({
      ...shared,
      name: `v${p}`,
      type: off ? "text" : "number",
      value: o.typed?.get(p) ?? v.v,
      mono: true,
      step: typeList(s).includes("integer") ? "1" : "any",
      ...(typeof s?.minimum === "number" ? { min: s.minimum } : {}),
      ...(typeof s?.maximum === "number" ? { max: s.maximum } : {}),
      ...(off ? { readonly: true } : { required: true }),
    });
  const text = v.t === "string" ? v.v : "";
  return field({
    ...shared,
    name: `v${p}`,
    value: text,
    ...(text.includes("\n") ? { type: "textarea", rows: Math.min(12, text.split("\n").length + 1) } : {}),
    ...(typeof s?.pattern === "string" ? { pattern: s.pattern } : {}),
    ...(off ? { readonly: true } : f.required ? { required: true } : {}),
  });
}

function errorLine(p: string, id: string, o: FieldsOptions): Html | null {
  const message = o.errors?.get(p);
  return message === undefined ? null : html`<span class="error" id="${id}-err">${message}</span>`;
}

function hint(s: Schema | undefined, id: string): Html | null {
  return typeof s?.description === "string" && s.description !== ""
    ? html`<span class="hint" id="${id}-hint">${s.description}</span>`
    : null;
}

/** A structural button: it skips the browser's checks, since removing a card must not wait for a field in it. */
const opBtn = (label: string, op: Op, at: string, plus?: "plus" | "trash", key?: string): Html =>
  btn(label, {
    name: "op",
    value: opValue(op, at, key),
    size: "sm",
    variant: op === "remove" ? "ghost" : "outline",
    formnovalidate: true,
    ...(plus === undefined ? {} : { icon: plus }),
  });

function node(v: Json, p: string, label: string, parentSchema: Schema | undefined, o: FieldsOptions): Html {
  const s = schemaAt(o.found, p);
  const id = `cf-${++fieldSerial}`;
  const title = typeof s?.title === "string" && s.title !== "" ? s.title : label;
  const required = Array.isArray(parentSchema?.required) && parentSchema.required.includes(label);
  const errored = o.errors?.has(p) === true;
  if (v.t === "object") {
    const body = objectBody(v, p, s, o);
    if (p === "") return body;
    return html`<fieldset class="field config-group" ${errored ? raw("data-invalid") : null}>
      <legend>${title}</legend>${hint(s, id)}${errorLine(p, id, o)}${body}
    </fieldset>`;
  }
  if (v.t === "array") {
    const cards = v.items.length > 0 ? !v.items.every(isScalar) : ["object", "array"].includes(typeList(s?.items)[0] ?? "");
    return html`<fieldset class="field config-group" ${errored ? raw("data-invalid") : null}>
      <legend>${title} <span class="muted small num">${v.items.length}</span></legend>
      ${hint(s, id)}${errorLine(p, id, o)}
      ${cards ? cardList(v, p, title, o) : chipList(v, p, s, o)}
      ${when(o.readonly !== true, () => html`<div class="form-actions">${opBtn(cards ? `Add ${title}` : "Add", "add", p, "plus")}</div>`)}
    </fieldset>`;
  }
  return scalarField(v, p, s, o, { label: title, required });
}

function objectBody(v: Extract<Json, { t: "object" }>, p: string, s: Schema | undefined, o: FieldsOptions): Html {
  const present = new Set(v.entries.map(([k]) => k));
  const missing = Object.keys(s?.properties ?? {}).filter((k) => !present.has(k));
  return html`${v.entries.map(([k, x]) => node(x, pointer(p, k), k, s, o))}
  ${when(
    o.readonly !== true && missing.length > 0,
    () => html`<div class="form-actions">${missing.map((k) => opBtn(k, "key", p, "plus", k))}</div>`,
  )}`;
}

function chipList(v: Extract<Json, { t: "array" }>, p: string, s: Schema | undefined, o: FieldsOptions): Html {
  if (v.items.length === 0) return html`<p class="muted small">Empty.</p>`;
  return html`<ul class="config-chips">
    ${v.items.map((x, i) => {
      const at = pointer(p, i);
      return html`<li>${scalarField(x, at, s?.items, o, {
        label: `${labelOf(p)} ${i + 1}`,
        required: false,
        labelHidden: true,
        after: o.readonly === true ? null : opBtn("Remove", "remove", at),
      })}</li>`;
    })}
  </ul>`;
}

function cardList(v: Extract<Json, { t: "array" }>, p: string, title: string, o: FieldsOptions): Html {
  return html`${v.items.map((x, i) => {
    const at = pointer(p, i);
    const last = v.items.length - 1;
    return html`<div class="config-card">
      <div class="bar">
        <strong>${title} ${i + 1}</strong><span class="spacer"></span>
        ${when(o.readonly !== true, () => html`${i > 0 ? opBtn("Up", "up", at) : null}${i < last ? opBtn("Down", "down", at) : null}${opBtn("Remove", "remove", at, "trash")}`)}
      </div>
      ${x.t === "object" ? objectBody(x, at, schemaAt(o.found, at), o) : node(x, at, `${title} ${i + 1}`, undefined, o)}
    </div>`;
  })}`;
}

/** Every field of `doc`, drawn as `o` says. */
export function configFields(doc: Json, o: FieldsOptions = {}): Html {
  fieldSerial = 0;
  if (doc.t !== "object" && doc.t !== "array") return node(doc, "", "value", undefined, o);
  return node(doc, "", "", undefined, o);
}
