FROM node:20-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json LICENSE ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    IDLERPG_DATA_DIR=/data \
    IDLERPG_CONFIG=/data/config.json

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json LICENSE ./
COPY --chown=node:node src ./src
COPY --chown=node:node locales ./locales
COPY --chown=node:node data/config.example.json data/events.example.txt data/events.pt-BR.example.txt ./data/
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data

USER node
VOLUME ["/data"]

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
