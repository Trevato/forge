// 60 — who a picture was taken as (#738): the owner, signed in as an
// admin, or nobody. A public app's previews are taken as nobody, and only
// a picture taken as nobody is a reader's to see. Every picture before
// this was the owner's, which is what the default says.
export default `
  ALTER TABLE look ADD COLUMN taken_as TEXT NOT NULL DEFAULT 'owner'
    CHECK (taken_as IN ('owner','nobody'));
  `;
