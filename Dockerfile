FROM node:22-slim
WORKDIR /app
RUN corepack enable

# Install dependencies first so they cache between code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY . .
# Builds the React app into apps/api/public and compiles the API to apps/api/dist.
RUN pnpm build

ENV PORT=3000
EXPOSE 3000
# On boot: run migrations (advisory-locked), seed the demo host if missing, start serving.
CMD ["node", "apps/api/dist/src/server.js"]
