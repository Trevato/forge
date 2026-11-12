/**
 * The forge's public origin, the one every door prints: the configured
 * `url`, else what the door itself knows (a page its request's origin, the
 * terminal its host and port). Never a trailing slash, so a line built on it
 * reads the same on the page and in the terminal.
 */
export function publicOrigin(configured: string | undefined, fallback: string): string {
  return (configured ?? fallback).replace(/\/+$/, "");
}
