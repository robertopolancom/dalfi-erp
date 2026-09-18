FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Con las de desarrollo: el build usa esbuild (scripts/build-erp-assets.mjs). Se quitan justo
# después, así que la imagen final lleva solo lo que corre en producción.
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
