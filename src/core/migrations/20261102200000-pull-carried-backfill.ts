// The pulls closed as carried before `pull.carried` existed (#8738): a carried
// close recorded the base it found as its merged commit (`closeAsMerged` in
// `core/pulls.ts`), which no real landing does — a merge or squash writes a
// new commit, a fast-forward the head. Imported pulls have no merged commit.
// A carried close onto an earlier landing of the same pull is not matched:
// that commit did land once, and the home figures count it once.
export default `
  UPDATE pull SET carried = 1
   WHERE carried = 0 AND merged_at IS NOT NULL
     AND merged_oid IS NOT NULL AND merged_oid != '' AND merged_oid = base_oid;
  `;
