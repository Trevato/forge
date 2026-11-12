/**
 * The words a file edit refuses in (#5544): one sentence per refusal kind,
 * so `POST …/contents` and any other door that writes a file say the same
 * thing for the same failure.
 */
export function editMessage(kind: string): string {
  switch (kind) {
    case "storage_limit":
      return "your forks are using all the space a guest gets; delete a fork to make room";
    case "protected_branch":
      return "the default branch is protected; only a repo admin may commit to it directly";
    case "file_too_large":
      return "that file is larger than an edit may carry; push it instead";
    case "commit_too_large":
      return "the edit is larger than one commit may carry; push it instead";
    case "branch_moved":
      return "the branch moved while this edit was being written; re-read and retry";
    case "land_refused":
      return "the origin refused this commit; nothing was changed here either";
    case "pull_failed":
      return "the commit landed, but the pull request could not be opened";
    case "invalid_path":
      return "that path cannot be written; use a plain relative path with no .. or .git";
    case "path_conflict":
      return "that path collides with a file or directory already in the tree";
    default:
      return "this edit could not be applied";
  }
}
