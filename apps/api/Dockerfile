# Build stage — compiles both the API and the React web app.
FROM node:20-alpine AS build
WORKDIR /app

# Enable pnpm via corepack
RUN corepack enable

# Copy workspace manifests first for better layer caching
COPY package.json pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json

# Install deps for both workspaces
RUN pnpm install --filter @slotbook/api... --filter @slotbook/web... --frozen-lockfile=false

# Build the API
COPY apps/api apps/api
RUN pnpm --filter @slotbook/api build

# Build the web app
COPY apps/web apps/web
RUN pnpm --filter @slotbook/web build

# Runtime stage — lean image with the API + the built web assets.
FROM node:20-alpine AS runtime
WORKDIR /app/apps/api
RUN corepack enable

ENV NODE_ENV=production

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/drizzle ./drizzle
COPY --from=build /app/apps/api/package.json ./package.json
# The server serves the SPA from ../web-dist (i.e. /app/apps/web-dist).
COPY --from=build /app/apps/web/dist ../web-dist

EXPOSE 4000
CMD ["node", "dist/server.js"]
