# syntax=docker/dockerfile:1.7

FROM node:26-bookworm-slim AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

COPY package.json ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/hub/package.json packages/hub/package.json
COPY packages/mcp-server/package.json packages/mcp-server/package.json
COPY packages/schema/package.json packages/schema/package.json
COPY packages/web/package.json packages/web/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .

FROM workspace AS web-build

# HUB_URL is only the bundle's fallback: the client prefers the hub endpoint
# Caddy serves at /uberblick-config.json (see the Caddyfile), so retargeting a
# deployment does not need this image rebuilt.
ARG HUB_URL
ARG HUB_AUTH_TOKEN_DIGEST
RUN --mount=type=secret,id=hub-auth-token \
    test -n "$HUB_URL" \
    && test -n "$HUB_AUTH_TOKEN_DIGEST" \
    && test -s /run/secrets/hub-auth-token \
    && HUB_URL="$HUB_URL" HUB_AUTH_TOKEN="$(cat /run/secrets/hub-auth-token)" \
       pnpm --filter @uberblick/web build

FROM caddy:2.10.2-alpine AS web

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/packages/web/dist /srv

FROM workspace AS hub

ENV NODE_ENV=production
ENV HUB_HOST=0.0.0.0
ENV PORT=1234
ENV HUB_DB_PATH=/data/hub.sqlite

RUN install -d -o node -g node /data

USER node
EXPOSE 1234
CMD ["packages/hub/node_modules/.bin/tsx", "packages/hub/src/main.ts"]
