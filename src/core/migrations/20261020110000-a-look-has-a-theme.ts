// A look knows which colour scheme it was taken in (#2736). `theme`
// defaults to 'light', so every row from before dark pictures reads as
// exactly what it was. Additive, so an older process keeps serving across
// a roll: the unique key is left as it is, and `core/looks.ts` files a
// dark look under a page of its own.
export default `
  ALTER TABLE look ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'
    CHECK (theme IN ('light','dark'));
  `;
