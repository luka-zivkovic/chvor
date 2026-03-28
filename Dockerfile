# Stage 1: Build client + shared package
FROM node:22-slim AS client-build
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY apps/client/ apps/client/
RUN pnpm --filter @chvor/shared build
RUN pnpm --filter @chvor/client build

# Stage 2: Install production deps with native module compilation
# Uses node:22 (full) which includes python3, make, g++ needed by better-sqlite3
FROM node:22 AS deps
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod --frozen-lockfile && \
    rm -rf node_modules/@chvor

# Stage 3: Production image
FROM node:22-slim
WORKDIR /app

# Copy production node_modules (with compiled native modules)
COPY --from=deps /app/node_modules node_modules

# Set up @chvor/shared as a real package (not a workspace symlink)
COPY --from=client-build /app/packages/shared/package.json node_modules/@chvor/shared/package.json
COPY --from=client-build /app/packages/shared/dist node_modules/@chvor/shared/dist

# Copy built frontend
COPY --from=client-build /app/apps/client/dist apps/client/dist

# Copy server source (runs .ts directly via Node 22 type stripping)
COPY package.json tsconfig.base.json ./
COPY apps/server/ apps/server/
COPY apps/client/package.json apps/client/

# Install Playwright for web-agent browser tool
RUN npx playwright install --with-deps chromium

# Pre-create data directory with correct ownership
RUN mkdir -p /home/node/.chvor/data && chown -R node:node /home/node/.chvor /app

# Entrypoint fixes bind-mount permissions then drops to 'node' user
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV CHVOR_DATA_DIR=/home/node/.chvor/data
EXPOSE 9147
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
