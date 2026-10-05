# ===================================
# db-monitor - Production Dockerfile
# ===================================

FROM node:20.18-alpine AS base

RUN apk add --no-cache libc6-compat openssl && \
    npm install -g pnpm@10.34.5

# ===================================
# Stage 1: Dependencies
# ===================================
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ===================================
# Stage 2: Build
# ===================================
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

ARG DATABASE_URL="postgresql://build:build@localhost:5432/build"
ARG AUTH_SECRET="build-placeholder-secret-not-used-at-runtime"

RUN pnpm exec prisma generate && \
    pnpm build

# ===================================
# Stage 3: Production
# ===================================
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# pg_dump and mariadb-dump for the "dump a database" actions (alpine 3.20 ships
# postgresql16-client and mariadb-client; the latter dumps MySQL 8 servers too).
RUN apk add --no-cache postgresql16-client mariadb-client && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

RUN npm install --no-save prisma@5.22.0 && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

RUN mkdir -p ./public
COPY --from=builder /app/public/ ./public/

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts/sqlite-sample.cjs ./scripts/sqlite-sample.cjs

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

COPY --from=builder /app/docker-entrypoint.sh ./
CMD ["sh", "docker-entrypoint.sh"]
