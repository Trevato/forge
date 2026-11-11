/**
 * Who the packs' upstream mirrors belong to (#10530): the account `packs`.
 * A repository under it is a read-only copy of an outside project; the only
 * thing that moves its branches is the scheduled follow. Pure data.
 */

export const PACKS_OWNER = "packs";

/** Whether a repository is one of the packs' mirrors. */
export const isPacksMirror = (repo: { readonly ownerName: string }): boolean =>
  repo.ownerName.toLowerCase() === PACKS_OWNER;

/** What a push to a mirror is told, at every door. */
export const MIRROR_PUSH_REFUSED =
  "This is a read-only mirror of an upstream project: it follows its upstream and takes no pushes.";
