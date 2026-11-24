# Analysis worker image (Node 22 + ffmpeg). Build from the content-os directory:
#   docker build -f worker/Dockerfile -t content-os-worker .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm install --no-save tsx@4.23.15
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker
USER node
CMD ["npx", "tsx", "worker/index.ts"]
