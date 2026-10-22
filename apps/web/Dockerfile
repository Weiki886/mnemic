FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY package.json ./
COPY scripts/prepare-pnpm.mjs ./scripts/prepare-pnpm.mjs
RUN corepack enable && node scripts/prepare-pnpm.mjs
COPY . .
RUN pnpm --filter @mnemic/web... install --frozen-lockfile
RUN VITE_API_BASE_URL=/api pnpm --filter @mnemic/web run build

FROM caddy:2-alpine AS runtime
COPY deploy/Caddyfile.web /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv
# Static port 8080 needs no low-port file capability; keeping it makes cap_drop: ALL fail exec.
RUN setcap -r /usr/bin/caddy && chown -R 1000:1000 /data /config /srv
USER 1000:1000
EXPOSE 8080
