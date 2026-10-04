# Build JavaScript once on the builder's native architecture.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts/build-server.mjs scripts/build-server.mjs
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_PATH=/app/data/hidden-crown.sqlite
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /app/data && chown node:node /app/data
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/healthz',{headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=256", "dist/server.mjs"]
