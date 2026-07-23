# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
ENV npm_config_audit=false \
    npm_config_fund=false

COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM dependencies AS build

COPY index.html vite.config.mjs ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    TZ=Asia/Shanghai \
    MONEYFLOW_DATA_DIR=/app/data

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist/client ./dist/client

RUN mkdir -p /app/data && chown -R node:node /app

USER node
EXPOSE 4173
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/index.mjs"]
