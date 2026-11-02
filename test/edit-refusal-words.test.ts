import { expect, test } from "bun:test";
import { editMessage } from "../src/actions/edit_words.ts";

// Each refusal kind gives its exact sentence, so every door that writes a
// file refuses in the same words (#5544).
const WORDS: Array<[string, string]> = [
  ["protected_branch", "the default branch is protected; only a repo admin may commit to it directly"],
  ["file_too_large", "that file is larger than an edit may carry; push it instead"],
  ["commit_too_large", "the edit is larger than one commit may carry; push it instead"],
  ["branch_moved", "the branch moved while this edit was being written; re-read and retry"],
  ["land_refused", "the origin refused this commit; nothing was changed here either"],
  ["pull_failed", "the commit landed, but the pull request could not be opened"],
  ["invalid_path", "that path cannot be written; use a plain relative path with no .. or .git"],
  ["path_conflict", "that path collides with a file or directory already in the tree"],
];

for (const [kind, sentence] of WORDS) {
  test(`editMessage(${kind}) says its sentence`, () => {
    expect(editMessage(kind)).toBe(sentence);
  });
}

test("an unknown kind falls back to the default sentence", () => {
  expect(editMessage("something_else")).toBe("this edit could not be applied");
  expect(editMessage("")).toBe("this edit could not be applied");
});
