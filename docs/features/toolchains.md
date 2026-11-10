# Pinned toolchains (rust)

An app names a toolchain in `forge.json`: `{ "toolchain": { "rust": "1.82" } }`.
Its **install** and **test** steps and its **run** command then see `cargo` and
`rustc` on `PATH`, with `CARGO_HOME` and `RUSTUP_HOME` set. Apps that do not
name it see none of this.

## Where it lives (and why)

A directory on the host, `$FORGE_TOOLCHAINS/rust/<version>/`, mounted read-only
in the cell. Chosen over a nix store path because it needs no daemon and no new
dependency: an admin unpacks a release once, and every deploy only reads it.
Nothing is downloaded per build: resolving a pin is a file check
(`toolchainUse`, `src/apps/toolchain.ts`), and the test asserts two deploys make
no fetch. `CARGO_HOME` is a writable `.cargo` in the environment's home (the
toolchain stays read-only); `RUSTUP_HOME` points into the toolchain.
The default install step is `cargo build --release --offline`; a dependency
fetch is the app's own, through its declared `egress`.

Layout: `bin/` (cargo, rustc, direct binaries, not rustup proxies), `rustup/`.

## An admin adds a Rust version

1. Unpack a standalone Rust release (`rust-<ver>-x86_64-unknown-linux-gnu`) and
   run its `install.sh --prefix=$FORGE_TOOLCHAINS/rust/<ver>`; `bin/cargo` must
   exist there. Make it read-only for the forge's user.
2. Add the `major.minor` string to `TOOLCHAINS.rust` in `src/apps/toolchain.ts`.
3. A pin the host lacks fails the deploy at install: "rust 1.82 is pinned but
   not installed on this host".

The fixture `test/fixtures/rust-hello/` is the minimal app; its test is skipped
by name where `cargo` is absent.
