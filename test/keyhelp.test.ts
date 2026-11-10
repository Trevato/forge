import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/web/client.ts', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../src/web/layout.ts', import.meta.url), 'utf8');

const helpStart = src.indexOf('// ---- help overlay');
const handlerStart = src.lastIndexOf("doc.addEventListener('keydown'", helpStart);
const handler = src.slice(handlerStart, helpStart);
const help = src.slice(helpStart, src.indexOf('// ---- command palette'));

test('the field guard returns before any plain key is read', () => {
  const guard = handler.indexOf("t.matches('input, textarea, select, [contenteditable]')");
  expect(guard).toBeGreaterThan(0);
  for (const key of ['j', 'k', 'o', '?', '/', ':', 'c', 'C']) {
    const at = handler.lastIndexOf(`e.key === '${key}'`);
    expect(at).toBeGreaterThan(guard);
  }
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
