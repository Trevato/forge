/**
 * Which config files open as a form, and how each is read and written back.
 * The form holds a `Json` whatever the file's language; this is the one
 * place that knows the language. JSON is rewritten whole in its own style;
 * YAML and TOML are patched, so their comments survive.
 */

import { detectStyle, parseJson, stringify, type Json, type Parsed } from "./json-doc.ts";
import { parseToml, writeToml } from "./toml-config.ts";
import { parseYaml, writeYaml } from "./yaml-config.ts";

export type ConfigFormat = "json" | "yaml" | "toml";

export function formatOf(path: string): ConfigFormat | undefined {
  if (/\.json$/i.test(path)) return "json";
  if (/\.ya?ml$/i.test(path)) return "yaml";
  if (/\.toml$/i.test(path)) return "toml";
  return undefined;
}

/** Whether the file opens as a form. */
export const isFormConfig = (path: string): boolean => formatOf(path) !== undefined;

const LANGUAGE: Readonly<Record<ConfigFormat, string>> = { json: "JSON", yaml: "YAML", toml: "TOML" };

/** The file's language, for messages: "Not valid YAML". Anything else reads as JSON. */
export const languageOf = (path: string): string => LANGUAGE[formatOf(path) ?? "json"];

/** The file's text as a document, or why it is not one. */
export function parseConfig(path: string, text: string): Parsed {
  switch (formatOf(path)) {
    case "yaml":
      return parseYaml(text);
    case "toml":
      return parseToml(text);
    default:
      return parseJson(text);
  }
}

export type Written = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/** The file's new text: `original`, with `after` (which it parsed to `before`) written in. */
export function writeConfig(path: string, original: string, before: Json, after: Json): Written {
  switch (formatOf(path)) {
    case "yaml":
      return writeYaml(original, before, after);
    case "toml":
      return writeToml(original, before, after);
    default:
      return { ok: true, text: stringify(after, detectStyle(original)) };
  }
}
