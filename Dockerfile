# The chess site for chess.pacificfish.ca. GitHub Actions builds this on every push to main
# (.github/workflows/publish.yml); the server only downloads the finished image.
#
# How the server runs it: as user 568 (not root), read-only files, about 128 MB of memory, plain
# HTTP on PORT (3000) behind Cloudflare's HTTPS. Stockfish runs in visitors' browsers, not here.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# Dependencies first, so pushes that only change code reuse this layer (none needed yet: the
# server uses Node's own modules; this is ready for stage 3's)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only what runs: the server and the site it serves (no tests)
COPY server ./server
COPY site ./site

# Files are owned by root and readable by everyone, which is what the server needs: it runs the
# container as user 568, and nothing here is written at runtime.
USER node
EXPOSE 3000

# node directly, not "npm start": npm writes logs into a home folder a read-only container lacks
CMD ["node", "server/server.mjs"]
