# AF2 on TPU v6e — the risk-gate container.
#
# Strategy: AlphaFold's model module is pure JAX/Haiku. The CUDA-specific
# bits live in run_alphafold.py's relax stage (OpenMM/AMBER), which we
# disable. The Evoformer + structure module forward pass should run on TPU.
#
# Build context: this directory (af2-tpu/)
# Run:           docker build -t af2-tpu:latest .
#
FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        git wget ca-certificates hmmer kalign \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone AF2 v2.3.2 source for the model code
RUN git clone --depth=1 --branch v2.3.2 https://github.com/google-deepmind/alphafold.git /app/alphafold

# Install JAX for TPU v6e Trillium FIRST (sets JAX version constraints)
RUN pip install --upgrade pip && \
    pip install "jax[tpu]" -f https://storage.googleapis.com/jax-releases/libtpu_releases.html

# Install AF2 deps with relaxed version pins — the model architecture
# is version-independent, only the weights (.npz) matter.
RUN pip install \
    absl-py biopython dm-haiku dm-tree immutabledict ml-collections \
    numpy pandas scipy chex docker tensorflow-cpu

# FastAPI + serving
RUN pip install fastapi uvicorn[standard] python-multipart google-cloud-storage

# Install AlphaFold as editable package
RUN pip install -e /app/alphafold

# Copy our predict adapter
COPY predict.py /app/predict.py
COPY main.py /app/main.py

ENV PYTHONPATH=/app/alphafold:/app
EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
