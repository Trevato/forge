/**
 * The forge's own directories stripped from a line of output — the data
 * directory, the app's id, the environment and the per-commit checkout are
 * the forge's private layout, not the app's; a stack trace naming
 * `dir/src/server.ts:1:11` reads as `src/server.ts:1:11` instead, the path
 * the app's own source control knows. Applied where output is captured, not
 * filtered — a line with no match passes through whole, so a message never
 * loses its stack for the sake of hiding a directory.
 *
 * An empty `dir` is dropped rather than stripped: `"".split("dir").join(".")`
 * would rewrite every character boundary of the line.
 */
export function stripForgeDirs(dirs: readonly string[], line: string): string {
  return dirs
    .filter((dir) => dir !== "")
    .reduce(
      (out, dir) => out.split(`${dir}/`).join("").split(dir).join("."),
      line,
    );
}
