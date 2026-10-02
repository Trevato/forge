# One Bun process, run from source. The host provides three binaries the
# forge asks for: git, `claude` for the crew (a Node program, hence node +
# npm), and chromium for the look — a picture of every green preview
# (docs/APPS.md). Chromium and a font to draw with add about 450 MB to the
# image; it is the largest thing here by far, and the only way to see a page
# as a browser does. package.json's dependency list is empty, so there is
# nothing to install.
FROM oven/bun:1.3-debian
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl bubblewrap socat nodejs npm tini chromium fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION
# Everything a forge instance is lives under FORGE_DATA — mount a volume there.
# 8080 is the port the platform's edge admits.
ENV FORGE_DATA=/data PORT=8080 FORGE_SSH_PORT=2222
EXPOSE 8080 2222
USER bun
# tini reaps what an agent run leaves behind: a claude run spawns git, bun,
# the app under test, and their children.
ENTRYPOINT ["tini", "--"]
CMD ["bun", "src/main.ts"]
