# One Bun process, run from source. The only system requirement is git;
# package.json's dependency list is empty, so there is nothing to install.
FROM oven/bun:1.3-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

ARG VERSION=dev
LABEL org.opencontainers.image.version=$VERSION
# Everything a forge instance is lives under FORGE_DATA — mount a volume there.
ENV FORGE_DATA=/data PORT=8080 FORGE_SSH_PORT=2222
EXPOSE 8080 2222
USER bun
CMD ["bun", "src/main.ts"]
