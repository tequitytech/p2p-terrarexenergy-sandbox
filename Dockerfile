# syntax=docker/dockerfile:1

# Builder stage: install all deps (incl. dev) and build TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies first (use cached layers when possible)
COPY package.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: install only production deps and copy build output
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy compiled code from builder
COPY --from=builder /app/dist ./dist
# Copy JSON files (they are not compiled by TypeScript)
COPY --from=builder /app/src/webhook/jsons ./dist/webhook/jsons
# Copy data folder for forecast files
COPY data ./data

# Copy firebase folder for push notifications
COPY firebase ./firebase

EXPOSE 3000

CMD ["node", "dist/index.js"]
