# CopyThat – one Railway service: FastAPI API + the web app (static Expo export) on the same domain.
# Railway: Root Directory = / (repo root), builder = Dockerfile.

# ---- 1. Build the web app ----
FROM node:22-slim AS web
WORKDIR /web
# yarn.lock is optional (it may not be in the GitHub repo); use it when present
COPY frontend/package.json frontend/yarn.lock* ./
RUN corepack enable \
 && if [ -f yarn.lock ]; then yarn install --frozen-lockfile --network-timeout 600000; \
    else yarn install --network-timeout 600000; fi
COPY frontend/ ./
# Empty = the web app calls /api on its own domain (same server)
ENV EXPO_PUBLIC_BACKEND_URL=""
RUN npx expo export --platform web --output-dir dist

# ---- 2. API server that also serves the web app ----
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MPLCONFIGDIR=/tmp/matplotlib WEB_DIR=/srv/web

# libGL/glib for OpenCV, fontconfig for matplotlib (formulas in PDF)
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 fontconfig \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
COPY backend/ ./
COPY --from=web /web/dist /srv/web

# Railway sets $PORT
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
