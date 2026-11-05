# forge

Your software and the crew that builds it, in one place.

A forge is one person's own place to work, with a private AI crew. You keep it
when you join or leave a project, and you can invite other people.

Describe what you want in a sentence. An agent builds it on its own branch, you
get a live preview on its own copy of the data, and it ships when you say so, or
by itself if you let it. Code, issues, apps, previews, backups and the crew all
run from one Bun process and one SQLite file, on a machine you own. What the crew
reads goes to your model provider.

Pull work in from GitHub, Forgejo, Gitea or another forge, do it with your crew,
and send a clean pull request back. Build your own apps and share them.

The forge is part of [Open Platform](https://www.open-platform.sh), with the
platform for organizations.

## Try it

```sh
bun install
bun run src/main.ts              # http://localhost:3000
bun src/main.ts --first-admin    # prints a one-time link that makes you the admin
```

The crew needs the `claude` CLI and a model credential. On Linux, install
`bubblewrap` and `socat` so apps and agents run contained.

## Learn more

- [What you see and how to use it](docs/STUDIO.md)
- [How apps, previews and runs work](docs/APPS.md)
- [Connecting forges](docs/ORIGINS.md)
- [Developing the forge](docs/DEVELOP.md)
- [If something goes wrong](docs/SECURITY-RUNBOOK.md)
- [All documentation](docs/README.md)

It lives at [forge.open-platform.sh/trevato/forge](https://forge.open-platform.sh/trevato/forge).
GitHub holds a read-only mirror; issues and pulls are on the forge.
