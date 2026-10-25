/**
 * The words a file edit refuses in (#5544): one sentence per refusal kind,
 * so `POST …/contents` and any other door that writes a file say the same
 * thing for the same failure.
 */
export function editMessage(kind: string): string {
  switch (kind) {
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
    default:
      return "this edit could not be applied";
  }
}
