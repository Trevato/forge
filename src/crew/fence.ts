/** `text` in a fence longer than any run of backticks inside it. */
export function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const bar = "`".repeat(longest + 1);
  return `${bar}\n${text}\n${bar}`;
}
