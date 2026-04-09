FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
# Mount a volume at /data and point recordings here (override if you prefer /data alone)
ENV MONITOR_RECORDINGS_DIR=/data/recordings

EXPOSE 9090
VOLUME ["/data"]

CMD ["node", "server.js"]
