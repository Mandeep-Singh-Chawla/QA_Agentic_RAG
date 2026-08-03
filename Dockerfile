# Production image for qa-agentic-rag HTTP API
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && node scripts/patch-qdrant-undici.mjs

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    QA_ENV=production \
    QA_AGENTIC_PORT=8787

RUN useradd --system --uid 10001 --create-home qaapp
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
COPY qa-agentic-rag ./qa-agentic-rag
COPY qa-docs ./qa-docs

RUN chown -R qaapp:qaapp /app
USER qaapp

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "qa-agentic-rag/server.ts"]
