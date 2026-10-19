# CopyThat web (static Expo export) for Railway. Root Directory = /frontend
# Requires the Railway variable EXPO_PUBLIC_BACKEND_URL (the API service's public URL, without /api).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile --network-timeout 600000
COPY . .
ARG EXPO_PUBLIC_BACKEND_URL
ENV EXPO_PUBLIC_BACKEND_URL=$EXPO_PUBLIC_BACKEND_URL
RUN test -n "$EXPO_PUBLIC_BACKEND_URL" || (echo "EXPO_PUBLIC_BACKEND_URL saknas" && exit 1)
RUN npx expo export --platform web --output-dir dist

FROM node:22-slim
RUN npm install -g serve@14
WORKDIR /site
COPY --from=build /app/dist ./
COPY serve.json ./serve.json
# Railway sets $PORT
CMD ["sh", "-c", "serve -c serve.json -l tcp://0.0.0.0:${PORT:-3000} ."]
