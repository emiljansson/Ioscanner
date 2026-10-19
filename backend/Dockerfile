# CopyThat API (FastAPI) for Railway. Root Directory = /backend
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MPLCONFIGDIR=/tmp/matplotlib

# libGL/glib for OpenCV, fontconfig for matplotlib (formulas in PDF)
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 fontconfig \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# emergentintegrations is in requirements.txt and lives on this extra index
RUN pip install --extra-index-url https://d33sy5i8bnduwe.cloudfront.net/simple/ -r requirements.txt

COPY . .

# Railway sets $PORT
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8001} --workers 1 --proxy-headers --forwarded-allow-ips='*'"]
