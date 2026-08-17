FROM --platform=$BUILDPLATFORM node:24-alpine AS build

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    NUXT_LOCAL_DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data

COPY --from=build --chown=node:node /app/.output ./.output

VOLUME ["/data"]

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", ".output/server/index.mjs"]
