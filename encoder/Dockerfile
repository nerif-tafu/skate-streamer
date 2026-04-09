FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY encoder.js ./
COPY lib ./lib

ENV NODE_ENV=production

# Hardware devices are passed at run time: --device /dev/video0 etc.
CMD ["node", "encoder.js"]
