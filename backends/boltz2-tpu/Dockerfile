# Boltz-2 on TPU v6e via TorchTPU.
# PyTorch diffusion model for protein+RNA+DNA+ligand structure prediction.
# Same TorchTPU pattern as ESMFold-TPU.
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PJRT_DEVICE=TPU

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# PyTorch CPU + torch_xla for TPU
RUN pip install --upgrade pip && \
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && \
    pip install "torch_xla[tpu]" -f https://storage.googleapis.com/libtpu-releases/index.html

# Boltz-2 from source (MIT license)
RUN pip install boltz

# Serving deps
RUN pip install fastapi uvicorn[standard] google-cloud-storage

COPY predict.py main.py /app/

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
