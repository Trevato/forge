// Where a connect goes when it finishes, kept on the connect in flight: the
// other forge's redirect comes back to one registered address, so a sign-in
// begun from `/bring` keeps its link here and not in that address. Empty for
// every flow that already exists, which return to Origins as they always did.
// Additive.
export default `
  ALTER TABLE oauth_flow ADD COLUMN return_query TEXT NOT NULL DEFAULT '';
  `;
