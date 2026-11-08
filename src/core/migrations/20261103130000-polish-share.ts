// The polish share (#8853): the percent of a week's agent spend that polish
// (issues labelled `polish`, or in the small-fixes lane) may take before
// dispatch stops picking it. 0 to 50, checked at the boundary; 10 to start. Additive.
export default `
  ALTER TABLE repo ADD COLUMN polish_share INTEGER NOT NULL DEFAULT 10;
  `;
