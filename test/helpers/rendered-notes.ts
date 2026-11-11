/**
 * The notes a rendered page stands with (#10998): every element wearing a
 * note, hint, muted or stat-note class whose words make prose (four or more),
 * outside the page's `?` help. The tag does not matter, so a paragraph turned
 * into a span still counts; table dashes and one-word labels do not.
 */
const NOTE = /<([a-z0-9]+)\b[^>]*\bclass="[^"]*\b(?:note|hint|muted|stat-note)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/g;

const withoutHelp = (page: string): string => page.replace(/<details[^>]*data-page-help[\s\S]*?<\/details>/g, "");

export const words = (fragment: string): number =>
  (fragment.replace(/<[^>]*>/g, " ").match(/[A-Za-z]{2,}/g) ?? []).length;

export const renderedNotes = (page: string): string[] =>
  [...withoutHelp(page).matchAll(NOTE)].map((m) => m[2] ?? "").filter((t) => words(t) >= 4);
