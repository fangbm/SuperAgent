FROM node:24-bookworm-slim

WORKDIR /app

RUN npm install --global pnpm@11.0.8

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY config ./config
COPY scripts ./scripts
COPY community/idle-abyss-princesses/bot-config.json ./community/idle-abyss-princesses/bot-config.json
COPY community/idle-abyss-princesses/core-config.json ./community/idle-abyss-princesses/core-config.json

RUN pnpm install --frozen-lockfile --prod=false && pnpm build && pnpm store prune

ENV NODE_ENV=production
USER node

ENTRYPOINT ["node", "scripts/superagent.mjs", "--config", "community/idle-abyss-princesses/core-config.json", "--database", "/data/archive.sqlite"]
