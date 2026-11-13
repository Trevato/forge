# Forge documentation

The forge is your software and the crew that builds it, in one place: a
self-hosted forge in one Bun process and one SQLite file that hosts code and runs
apps, with AI agents that build. Forges connect to one another.

The forge is part of [Open Platform](https://www.open-platform.sh), with the
platform for organizations.

## Use it

- [The studio](STUDIO.md): the web interface and the words it uses.
- [Tour](TOUR.md): every other page and screen, and each way to reach it.
- [Apps](APPS.md): apps, previews, runs and the rules the forge enforces.
- [The crew](CREW.md): how agents build, review and land work.
- [Asks](ASKS.md): what waits on a person and how to answer it.
- [Cloning over git](GIT.md): smart HTTP, SSH and large repositories.
- [MCP](MCP.md): the forge as a Model Context Protocol server.
- [The `forge` command](CLI.md): every command, with an example.

## Run it

- [Run it](REFERENCE.md#run-it): start a forge and create the first admin.
- [On your machine](ON-YOUR-MACHINE.md): the local copy, offline work and the binary.
- [Send a change without a forge](features/send-a-change.md): fork, source archive, patch, pull.

## Connect forges

- [Origins](ORIGINS.md): connect accounts on other forges, mirror and write through.
- [A forge is an origin](features/forge-origin.md): connect one forge to another.
- [The forge toolbar](features/forge-toolbar.md): the pill in every app and preview.

## Operate it

- [Operating](OPERATING.md): configuration, health, releases, switches and limits.
- [Metrics](METRICS.md): the Prometheus endpoint.
- [Failure domains](DOMAINS.md): the ways the forge stops and what it reports.
- [An app's own domain](features/app-own-domain.md): cut-over, certificate, and the way back.
- [Snapshots](SNAPSHOT.md): nightly copies and what they hold.
- [Recovery](RECOVERY.md): a printable guide for a forge in trouble.
- [Restore](RESTORE.md): bring a forge back on a fresh machine.

## Secure it

- [Security runbook](SECURITY-RUNBOOK.md): what to do, with no AI, under load or after a leak.
- [Threats](THREATS.md): each protection and its test. Protections with no test are listed as gaps.

## Develop it

- [Developing the forge](DEVELOP.md): tests, checks, the gate, lint and types.
- [Architecture](ARCHITECTURE.md): the principles and the shape of the system.
- [Writing](WRITING.md): how to write documentation for the forge.
- [Reference](REFERENCE.md): the long reference and the list of every document.
