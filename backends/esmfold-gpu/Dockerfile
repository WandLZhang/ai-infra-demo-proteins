# ESMFold on A100 GPU — the easiest backend (stock HuggingFace transformers).
# facebook/esmfold_v1: 2.1M downloads, MIT license.
# Single-sequence folding — no MSA pipeline, no databases.
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip git \
    && ln -sf /usr/bin/python3.11 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip && \
    pip install torch --index-url https://download.pytorch.org/whl/cu124 && \
    pip install transformers accelerate einops && \
    pip install fastapi uvicorn[standard] google-cloud-storage

COPY predict.py main.py /app/

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
