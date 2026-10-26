# --- frontend build --------------------------------------------------------
# Built inside the image: `frontend/dist/` is gitignored, so a clean clone used
# to fail at `COPY frontend/dist/`.
FROM oven/bun:1 AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend/ ./
RUN bunx vite build

# --- runtime ---------------------------------------------------------------
FROM python:3.12-slim

WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend /fe/dist ./frontend/dist

ENV DATA_DIR=/data \
    PYTHONUNBUFFERED=1
VOLUME /data
EXPOSE 3000

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "3000"]
