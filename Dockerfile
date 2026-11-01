FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ && npm ci --omit=dev && apk del python3 make g++
COPY . .
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app/data /app/uploads
VOLUME ["/app/data", "/app/uploads"]
EXPOSE 3000
USER node
CMD ["node", "server.js"]
