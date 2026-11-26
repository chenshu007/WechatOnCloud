FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    sqlcipher \
    ffmpeg \
    gdb \
    gcc \
    g++ \
    python3-dev \
    libsqlcipher-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    pycryptodome \
    zstandard \
    pilk \
    google-genai

WORKDIR /app
