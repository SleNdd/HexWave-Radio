FROM node:26-alpine AS build

RUN apk add --no-cache build-base python3
WORKDIR /app
COPY deploy/discord-radio/package.json deploy/discord-radio/package-lock.json ./
RUN npm ci
COPY deploy/discord-radio/tsconfig.docker.json ./tsconfig.json
COPY apps/discord-radio/src ./src
RUN npx tsc \
 && npm prune --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production
RUN apk add --no-cache ffmpeg ca-certificates \
 && addgroup -S radio \
 && adduser -S -G radio -h /app radio
WORKDIR /app
COPY --from=build --chown=radio:radio /app/package.json /app/package-lock.json ./
COPY --from=build --chown=radio:radio /app/node_modules ./node_modules
COPY --from=build --chown=radio:radio /app/dist ./dist
RUN mkdir -p /app/var/data /app/var/cache/media /app/var/cache/tts \
 && chown -R radio:radio /app/var
USER radio
EXPOSE 9380
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:9380/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
