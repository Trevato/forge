// A pull closed as already on the base landed nothing (#8628): the vitals and
// the home KPIs count a landing only where this is 0. Every pull before is 0.
// Additive.
export default `
  ALTER TABLE pull ADD COLUMN carried INTEGER NOT NULL DEFAULT 0;
  `;
