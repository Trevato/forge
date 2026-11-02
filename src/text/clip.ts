/** Fold whitespace runs to one space, trim, and cut to at most `max` code points, ending in "…" when cut. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const limit = Math.max(0, Math.floor(max) || 0);
  const points = Array.from(flat);
  if (points.length <= limit) return flat;
  if (limit === 0) return "";
  return `${points.slice(0, limit - 1).join("")}…`;
}
