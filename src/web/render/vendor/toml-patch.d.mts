/** The part of `@decimalturn/toml-patch` the config form uses (`render/toml-config.ts`). */

/** A TOML document as plain data; dates come back as `Date` subclasses. */
export function parse(source: string): Record<string, unknown>;
/** `source` with only what differs in `updated` rewritten: comments and layout stay. */
export function patch(source: string, updated: unknown): string;
