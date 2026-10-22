FROM node:22-bookworm-slim AS deps
WORKDIR /workspace
ENV CI=true
COPY package.json ./
COPY scripts/prepare-pnpm.mjs ./scripts/prepare-pnpm.mjs
RUN corepack enable && node scripts/prepare-pnpm.mjs
COPY . .
RUN pnpm --filter @mnemic/server... install --prod --frozen-lockfile

FROM deps AS build
RUN pnpm --filter @mnemic/server... install --frozen-lockfile
RUN pnpm --filter @mnemic/server... run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /workspace/node_modules ./node_modules
COPY --from=deps --chown=node:node /workspace/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps --chown=node:node /workspace/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=node:node /workspace/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /workspace/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /workspace/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=node:node /workspace/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /workspace/packages/shared/dist ./packages/shared/dist
WORKDIR /app/apps/server
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
