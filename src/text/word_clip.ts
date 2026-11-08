/** Fold whitespace, then cut to at most `max` characters at a word, ending in "…" when cut. */
export function wordClip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const room = flat.slice(0, Math.max(max - 1, 0));
  const whole = flat[room.length] === " " ? room : room.slice(0, Math.max(room.lastIndexOf(" "), 0));
  return `${whole.replace(/[\s(]+$/, "")}…`;
}
