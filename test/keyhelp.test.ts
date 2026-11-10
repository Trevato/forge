import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { shellJs } from '../src/web/client.ts';

const src = readFileSync(new URL('../src/web/client.ts', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/web/layout.ts', import.meta.url), 'utf8');

const helpStart = src.indexOf('// ---- help overlay');
const handlerStart = src.lastIndexOf("doc.addEventListener('keydown'", helpStart);
const handler = src.slice(handlerStart, helpStart);
const help = src.slice(helpStart, src.indexOf('// ---- command palette'));

test('the field guard returns before any plain key is read', () => {
  const guard = handler.indexOf("t.matches('input, textarea, select, [contenteditable]')");
  expect(guard).toBeGreaterThan(0);
  // The keys are looked up in the table, after the guard.
  expect(handler.indexOf('rowForKey(e.key)')).toBeGreaterThan(guard);
  // The chords are looked up ahead of it.
  expect(handler.indexOf("rowForKey('Mod+'")).toBeLessThan(guard);
  // The guard block ends in a bare return: nothing typed in a field falls through.
  const block = handler.slice(guard, handler.indexOf('if (e.metaKey || e.ctrlKey || e.altKey) return;'));
  expect(block).toMatch(/\n\s+return;\n\s+\}\n/);
});

test('an open dialog owns its keys', () => {
  expect(handler).toContain("t.closest('dialog[open]')) return;");
});

test('j/k, enter, esc and ? are rows of the one table the sheet renders', () => {
  const table = src.match(/var STATIC_KEYS = \[([\s\S]*?)\n  \];/)?.[1] ?? '';
  for (const label of ["'j / k'", "'o or Enter'", "'?'", "'Esc'"]) expect(table).toContain(label);
  expect(help).toContain('pageKeys().concat(STATIC_KEYS)');
  expect(help).toContain("querySelectorAll('[data-shortcut]')");
});

test('the sheet opens as the shared modal, which closes on Esc and returns focus', () => {
  expect(help).toContain('openModal(dlg);');
  expect(src).toContain('var was = document.activeElement;');
  expect(src).toContain("if (e.key !== 'Escape') return;");
  expect(src).toContain('was.focus()');
});

test('the dialog is out of the flow and in the page chrome, built without innerHTML', () => {
  expect(layout).toContain('id="help-dialog"');
  expect(help).not.toMatch(/\.innerHTML\s*[=+]/);
});

// Evaluate the table itself: the rows between `function submitBox` and the sheet's builder,
// with the handler's helpers stubbed, on a page that carries every page row.
function table(page: { box?: boolean; submit?: boolean } = { box: true, submit: true }) {
  const code = shellJs.slice(shellJs.indexOf('function submitBox'), shellJs.indexOf('// Built with DOM nodes'));
  expect(code).toContain('var STATIC_KEYS');
  const doc = {
    querySelector: (q: string) => (q === 'form[data-submit-key]' ? (page.submit ? {} : null) : q === '[data-box]' ? { getAttribute: () => 'Reply' } : null),
  };
  const f = new Function(
    'doc', 'pageBox', 'focusBox', 'openPalette', 'move', 'openFocused', 'openGoto', 'hints', 'openHelp', 'leaveToList', 'openNewIssue', 'escClosedHints',
    `${code}\nreturn { STATIC_KEYS: STATIC_KEYS, PAGE_KEYS: PAGE_KEYS, pageKeys: pageKeys, rowForKey: rowForKey };`,
  );
  const noop = () => {};
  return f(doc, () => (page.box ? {} : null), () => true, noop, noop, noop, noop, noop, noop, noop, () => false, noop, false) as {
    STATIC_KEYS: any[][]; PAGE_KEYS: string[]; pageKeys: () => any[][]; rowForKey: (k: string) => any[] | undefined;
  };
}

test('every row of the table, and of a page that earns them all, has an action', () => {
  const t = table();
  const rows = [...t.STATIC_KEYS, ...t.pageKeys()];
  expect(rows.length).toBeGreaterThanOrEqual(10);
  for (const r of rows) {
    expect(typeof r[0]).toBe('string');
    expect(Array.isArray(r[2]) && r[2].length > 0).toBe(true);
    expect(typeof r[3]).toBe('function');
  }
});

test('every key a row lists resolves to that row, chords included', () => {
  const t = table();
  for (const r of [...t.STATIC_KEYS, ...t.pageKeys()]) for (const k of r[2] as string[]) expect(t.rowForKey(k)?.[0]).toBe(r[0]);
  expect(t.rowForKey('Mod+k')?.[0]).toBe('Cmd/Ctrl K');
  expect(t.rowForKey('Mod+Enter')?.[0]).toBe('Cmd/Ctrl Enter');
  expect(t.rowForKey('x')).toBeUndefined();
});

test('the keys a page row may answer are the ones the cheap lookup lets through', () => {
  const t = table();
  const keys = t.pageKeys().flatMap((r) => r[2] as string[]);
  for (const k of keys) expect(t.PAGE_KEYS).toContain(k);
  // A page without a submit form lists no chord for it.
  expect(table({ box: false, submit: false }).rowForKey('Mod+Enter')).toBeUndefined();
});

test('the label of each row names the keys it answers', () => {
  const t = table();
  for (const r of [...t.STATIC_KEYS, ...t.pageKeys()]) {
    const shown = (r[0] as string).toLowerCase().replace('esc', 'escape').replace('cmd/ctrl', 'mod').replace(/ /g, '');
    for (const k of r[2] as string[]) {
      const key = k.toLowerCase().replace('mod+', 'mod');
      expect(shown.includes(key.replace(/^mod/, '')) || shown.includes(key)).toBe(true);
    }
  }
});

test('after the guards the handler reads no key literally but Escape; the table answers', () => {
  const after = handler.slice(handler.indexOf('if (e.metaKey || e.ctrlKey || e.altKey) return;'));
  expect([...after.matchAll(/e\.key === '([^']+)'/g)].map((m) => m[1])).toEqual(['Escape']);
  // Before the field guard the chords are looked up in the table too, not written out.
  const before = handler.slice(0, handler.indexOf("t.matches('input, textarea, select, [contenteditable]')"));
  expect(before).toContain("rowForKey('Mod+'");
  expect(before).not.toContain("e.key === 'Enter'");
});
