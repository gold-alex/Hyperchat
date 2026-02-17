FROM node:20-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY lib ./lib

ENV LP_GATEWAY_PORT=8787

CMD ["pnpm", "gateway:start"]
