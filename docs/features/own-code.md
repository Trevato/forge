# A forge that runs its own code

A forge you sent runs this forge's code until you switch it. Once switched, it
starts from its own `<org>/forge` repository's main, so changes made there are
what it runs. Its limits, sandbox and egress rules are set by this forge, not
by its code, and they are the same either way.

## Switch it

- **Page:** open `/forges`. Under **Forge code**, press **Use its own code**
  on the forge's row. Press **Use this forge's code** to switch back.
- **Terminal:** open the palette, choose **Forges you sent**, press `o` and
  pick the forge. The picker says whose code each forge runs and when it
  last rolled back.

A running forge is put to sleep. Its next visitor wakes it on the new code.

Only a forge in its own cell, with a forge repository, can be switched. A
forge that shares this forge's process is told so and stays as it is.

## What a start does

1. It copies its main into this forge's data, under `own-code/<name>/<commit>`.
   The repository and the copy must each stay under 256 MB and 50,000 files.
   The copy must hold no symbolic links, a `src/main.ts` that parses and a
   `forge.json`.
2. It starts the cell on that copy. If the copy fails its check, or the cell
   does not answer in time, it tries the last commit that came up, then this
   forge's code.
3. Each fallback is a **Rolled back** row on `/forges` and a
   `forge.rolled_back` event, in fixed words. A commit that failed is not
   tried again until main moves.

How a child running its own code is contained: `docs/THREATS.md`.
