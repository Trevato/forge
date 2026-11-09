# One Bun process, run from source. The host provides three binaries the
# forge asks for: git, `claude` for the crew (a Node program, hence node +
# npm), and chromium for the look — a picture of every green preview
# (docs/APPS.md). Chromium and a font to draw with add about 450 MB to the
# image; it is the largest thing here by far, and the only way to see a page
# as a browser does. package.json's dependency list is empty, so there is
# nothing to install.
# The Bun version is chosen, not floated: a rebuild must not change the
# runtime unasked. Whether to move off 1.3.14 waits on the decode issue (#3726).
FROM oven/bun:1.3.14-debian
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends git ca-certificates curl bubblewrap socat nodejs npm tini chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
# The principles the forge's own agents are briefed with (src/crew/principles.ts).
COPY docs/PRINCIPLES.md ./docs/PRINCIPLES.md
# The design principles a src/web/ review is held to (src/crew/design_principles.ts).
COPY docs/DESIGN.md ./docs/DESIGN.md
# The OpenCode plugin the forge serves at /plugins/opencode/forge.ts (src/http/plugin_routes.ts).
COPY plugins/opencode ./plugins/opencode
# src/ alone: nothing under it imports scripts/ or test/ (test/src-imports.test.ts),
# and the boot proof below fails the build if that ever stops being so (#2652).

# What the running forge says it is (src/kernel/version.ts): the release
# passes the tag it is building as VERSION and the commit as COMMIT, and the
# process reads them back. No file in the repository carries the number.
ARG VERSION=dev
ARG COMMIT=""
LABEL org.opencontainers.image.version=$VERSION
ENV FORGE_VERSION=$VERSION FORGE_COMMIT=$COMMIT
# Everything a forge instance is lives under FORGE_DATA — mount a volume there.
# 8080 is the port the platform's edge admits.
ENV FORGE_DATA=/data PORT=8080 FORGE_SSH_PORT=2222
EXPOSE 8080 2222
USER bun
# The build boots what it built (#2652): `src/main.ts` on an empty data
# directory must answer /api/v1/health as $VERSION, or the build fails and
# nothing is pushed. 0.7.166 passed its check from the repository and crashed
# at import from this image.
RUN bun src/release/boot.ts
# tini reaps what an agent run leaves behind: a claude run spawns git, bun,
# the app under test, and their children.
ENTRYPOINT ["tini", "--"]
# The launcher runs src/main.ts, and when this version does not answer health
# within FORGE_READY_GRACE_S (150), runs the last version that did, kept on
# the volume (src/release/launch.ts, #2652).
CMD ["bun", "src/release/launch.ts"]
