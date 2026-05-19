# ESMFold on TPU v6e via TorchTPU — the Slide 12 validation gate.
#
# Uses torch_xla to run the PyTorch ESMFold model on TPU.
# If this works, it proves TorchTPU isn't just a talking point.
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PJRT_DEVICE=TPU

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN pip install --upgrade pip && \
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu && \
    pip install "torch_xla[tpu]" -f https://storage.googleapis.com/libtpu-releases/index.html && \
    pip install transformers accelerate einops && \
    pip install fastapi uvicorn[standard] google-cloud-storage

COPY predict.py main.py /app/

EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
