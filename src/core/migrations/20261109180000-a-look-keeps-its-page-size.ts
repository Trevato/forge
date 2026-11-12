// A look keeps the size its page reported (#10202): the document's scroll
// size and the window's inner size, so "does this page scroll sideways" is
// answered from the row. Nullable, so every look from before reads as it
// was: no size. Additive.
export default `
  ALTER TABLE look ADD COLUMN scroll_width INTEGER;
  ALTER TABLE look ADD COLUMN scroll_height INTEGER;
  ALTER TABLE look ADD COLUMN inner_width INTEGER;
  ALTER TABLE look ADD COLUMN inner_height INTEGER;
  `;
