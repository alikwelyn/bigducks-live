FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/relay ./relay
COPY --from=build /app/shared ./shared
COPY --from=build /app/dist ./dist
EXPOSE 3001
USER node
CMD ["node", "relay/server.js"]
