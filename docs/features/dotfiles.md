# Your dotfiles in every shell

Settings → "Dotfiles" takes one line: `owner/name`, a repository on this forge that you can read, or empty for none. Anything else, or a repository you cannot read, is refused.

A new machine shell copies that repository's top-level dotfiles (default branch) into the shell's home after the forge's own rc is written, so the forge's defaults come first and yours win. The rc sources `.bashrc` itself; other files (`.gitconfig`, `.tmux.conf`, `.vimrc`) are read by their own tools. Nothing else is run.

Limits: regular files only (no symlinks or folders), names like `.word`, never `.git` or `.forge_*`, 64 KB each, 32 files. Files a previous session copied are removed first, so changing or clearing the setting leaves none behind.

If the repository is missing or you lost access, the shell opens anyway and its greeting names the repository once.

Set it on Settings › Shells, or in the terminal with the palette entry "Your dotfiles" (`e` to name, `x` to clear); both go through `setDotfilesRepo`. Files are written by removing the old entry first, so a symlink planted in the home is replaced, never followed.

Code: `src/machines/dotfiles.ts`, `src/tui/screens/dotfiles.ts`; tests in `test/machine-rc.test.ts`, `test/dotfiles-route.test.ts`, `test/tui-dotfiles.test.ts`.
