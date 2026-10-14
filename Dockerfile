# Production image for both the API and the worker.
# Runtime dependencies only; tests and dev tooling are not installed.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deterministic production dependencies first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source and the assets needed at runtime.
COPY src ./src
COPY scripts ./scripts
COPY db ./db

# Run as the unprivileged user bundled with the base image.
USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
