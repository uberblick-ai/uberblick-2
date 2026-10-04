# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches patches
COPY packages/cli/package.json packages/cli/package.json
COPY packages/hub/package.json packages/hub/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/web/package.json packages/web/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

FROM workspace AS web-build

# Every deployment setting comes from the served configuration document.
# The checkout build retains development fallbacks; released web images also
# disable those fallbacks through their explicit runtime-only build mode.
RUN pnpm --filter @uberblick/web build

FROM caddy:2.10.2-alpine AS web

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/packages/web/dist /srv
COPY web-release-entrypoint.sh remote-settings.sh /usr/local/bin/
ENTRYPOINT ["sh", "/usr/local/bin/web-release-entrypoint.sh"]
CMD ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

FROM workspace AS hub

ENV NODE_ENV=production
ENV HUB_HOST=0.0.0.0
ENV PORT=1234
ENV HUB_DB_PATH=/data/hub.sqlite

# Operator scripts use this same bundled setup command in checkout and release
# deployments, so their behavior does not depend on a source-tree entrypoint.
RUN node scripts/build-hub-release-payload.mjs /app \
    && install -d -o node -g node /data
COPY hub-release-entrypoint.sh remote-settings.sh /usr/local/bin/
ENTRYPOINT ["sh", "/usr/local/bin/hub-release-entrypoint.sh"]

USER node
EXPOSE 1234
CMD ["packages/hub/node_modules/.bin/tsx", "packages/hub/src/main.ts"]
