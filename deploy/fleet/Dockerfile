# Image for the simulated fleet: the fake /v1 server and the fake agents (test tooling only).
# Build context is the repository root:  docker compose -f deploy/fleet/docker-compose.yml build
FROM node:24-slim AS build
WORKDIR /app
# Install scripts are off project-wide (.npmrc); nothing is compiled during install.
COPY package.json package-lock.json .npmrc ./
COPY config ./config
COPY tsconfig.json ./
COPY packages ./packages
COPY tests/fakes ./tests/fakes
RUN npm ci
RUN npx tsc -b config/tsconfig.build.json
RUN npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
# Run as an unprivileged user; the shared volume is the only thing that is written.
COPY --from=build --chown=node:node /app /app
USER node
ENV NODE_ENV=production
