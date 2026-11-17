# Hey-Okay API server. Build: docker build -t heyokay-server .  (context = this folder)
# node:sqlite needs Node >= 22.13.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/heyokay.db
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# /data is a persistent volume on Fly (see fly.toml); SQLite lives there until Postgres lands.
RUN mkdir -p /data
EXPOSE 8787
CMD ["node", "--enable-source-maps", "dist/index.js"]
