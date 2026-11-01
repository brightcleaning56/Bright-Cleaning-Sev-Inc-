# BUILDINTEL API server. No runtime dependencies, so there is no npm install step.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    BUILDINTEL_DATA_FILE=/var/data/state.json \
    BUILDINTEL_OUTBOX_DIR=/var/data/outbox
COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
EXPOSE 8080
CMD ["node", "src/index.js"]
