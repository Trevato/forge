import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/web/client.ts', import.meta.url), 'utf8');

// The document keydown handler, up to the help overlay that follows it.
const end = src.indexOf('// ---- help overlay');
const start = src.lastIndexOf("doc.addEventListener('keydown'", end);
const handler = src.slice(start, end);

const answered = (): Set<string> => {
  const keys = new Set<string>();
  for (const m of handler.matchAll(/e\.key === '([^']+)'/g)) keys.add((m[1] ?? '').toLowerCase());
  return keys;
};

// A STATIC_KEYS label ("j / k", "o or Enter", "Cmd/Ctrl K", "Esc") as key names.
const named = (label: string): string[] => {
  const words = label
    .replace('Cmd/Ctrl', ' ')
    .split(/\s+or\s+|\s+\/\s+|\s+/)
    .filter(Boolean)
    .map((w) => (w === 'Esc' ? 'escape' : w.toLowerCase()));
  return words;
};

const listed = (): Set<string> => {
  const block = src.match(/var STATIC_KEYS = \[([\s\S]*?)\n  \];/)?.[1] ?? '';
  expect(block).not.toBe('');
  const keys = new Set<string>();
  for (const m of block.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']*'\s*\]/g)) for (const k of named(m[1] ?? '')) keys.add(k);
  // `c` is a row pageKeys() adds on pages that carry a box.
  if (/out\.push\(\['c',/.test(src)) keys.add('c');
  return keys;
};

test('the handler and the help overlay are both found', () => {
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(answered().size).toBeGreaterThan(5);
});

test('every key the handler answers has a row in STATIC_KEYS', () => {
  const rows = listed();
  expect([...answered()].filter((k) => !rows.has(k))).toEqual([]);
});

test('every key STATIC_KEYS names is answered by the handler', () => {
  const keys = answered();
  expect([...listed()].filter((k) => !keys.has(k))).toEqual([]);
});

test(': opens the palette and is listed', () => {
  expect(handler).toContain("e.key === ':'");
  expect(src).toContain("[':', 'Go to a page by name']");
});
