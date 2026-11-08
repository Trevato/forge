/** The part of the `yaml` package the config form uses (`render/yaml-config.ts`). */

export interface Node {
  /** Comment lines above the node. */
  commentBefore?: string | null;
  comment?: string | null;
}
export interface Scalar extends Node {
  value: unknown;
  source?: string;
}
export interface Pair {
  key: unknown;
  value: unknown;
}
export interface YAMLMap extends Node {
  items: Pair[];
}
export interface YAMLSeq extends Node {
  items: unknown[];
}
export interface Alias extends Node {
  resolve(doc: Document): unknown;
}
export interface YAMLError {
  message: string;
  linePos?: [{ line: number; col: number }, { line: number; col: number }?];
}
export interface Document {
  contents: unknown;
  /** Offsets into the source: start, end of the value, end of the document. */
  range: [number, number, number];
  errors: YAMLError[];
  warnings: YAMLError[];
  getIn(path: readonly (string | number)[], keepScalar?: boolean): unknown;
  setIn(path: readonly (string | number)[], value: unknown): void;
  deleteIn(path: readonly (string | number)[]): boolean;
  toString(options?: { lineWidth?: number; indent?: number; indentSeq?: boolean }): string;
}
export function parseAllDocuments(source: string, options?: { prettyErrors?: boolean; uniqueKeys?: boolean; maxAliasCount?: number }): Document[];
export function isScalar(node: unknown): node is Scalar;
export function isMap(node: unknown): node is YAMLMap;
export function isSeq(node: unknown): node is YAMLSeq;
export function isAlias(node: unknown): node is Alias;
