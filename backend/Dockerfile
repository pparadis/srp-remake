# Build from the repo root (see docker-compose.yml): the backend bundles the
# shared game engine from src/game and the track data from public/tracks.
FROM node:24-alpine AS build
WORKDIR /app/backend

COPY backend/package*.json ./
RUN npm install

COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY src/game /app/src/game
COPY public/tracks /app/public/tracks
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY backend/package*.json ./
RUN npm install --omit=dev

COPY --from=build /app/backend/dist ./dist

EXPOSE 3001
CMD ["npm", "run", "start"]
