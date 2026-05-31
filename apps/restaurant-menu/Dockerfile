# Multi-stage build for Restaurant Menu.
FROM node:20-alpine AS builder
WORKDIR /work
RUN apk add --no-cache git python3 make g++
RUN npm install -g pnpm@9
COPY package.json pnpm-workspace.yaml ./
COPY packages/core ./packages/core
COPY apps/restaurant-menu ./apps/restaurant-menu
RUN pnpm install --no-frozen-lockfile
WORKDIR /work/apps/restaurant-menu
RUN pnpm exec vite build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache git
COPY --from=builder /work/package.json /work/pnpm-workspace.yaml ./
COPY --from=builder /work/node_modules ./node_modules
COPY --from=builder /work/packages ./packages
COPY --from=builder /work/apps/restaurant-menu/package.json ./apps/restaurant-menu/package.json
COPY --from=builder /work/apps/restaurant-menu/node_modules ./apps/restaurant-menu/node_modules
COPY --from=builder /work/apps/restaurant-menu/dist ./apps/restaurant-menu/dist
COPY apps/restaurant-menu/server.js ./apps/restaurant-menu/server.js
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
WORKDIR /app/apps/restaurant-menu
CMD ["node", "server.js"]
