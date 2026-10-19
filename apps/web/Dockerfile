FROM node:22-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.32.0 --activate
COPY . .
RUN pnpm --filter @mnemic/web... install --frozen-lockfile
RUN VITE_API_BASE_URL=/api pnpm --filter @mnemic/web run build

FROM caddy:2-alpine AS runtime
COPY deploy/Caddyfile.web /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist /srv
RUN chown -R 1000:1000 /data /config /srv
USER 1000:1000
EXPOSE 8080
