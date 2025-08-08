# ---- Build stage ----
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm install --production --silent && mv node_modules prod_node_modules

# ---- Release image ----
FROM node:20-alpine
WORKDIR /app
COPY --from=base /app/prod_node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"] 