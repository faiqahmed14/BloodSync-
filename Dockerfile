# Works on Render, Railway, Fly.io, or any VPS with Docker:  docker build -t bloodsync . && docker run -p 4000:4000 --env-file bloodsync-backend/.env bloodsync
FROM node:20-alpine
WORKDIR /app

# Install dependencies first so Docker can cache this layer between code changes.
COPY bloodsync-backend/package.json bloodsync-backend/package-lock.json ./bloodsync-backend/
RUN cd bloodsync-backend && npm ci --omit=dev

# The backend serves the website from the sibling folder, so both are copied.
COPY bloodsync-backend ./bloodsync-backend
COPY bloodsync-frontend ./bloodsync-frontend

ENV NODE_ENV=production
WORKDIR /app/bloodsync-backend
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:${PORT:-4000}/api/health || exit 1
CMD ["node", "server.js"]
