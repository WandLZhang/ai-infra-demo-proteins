FROM us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# System deps
RUN apt-get update -qq && apt-get install -y -qq git libpython3.10 && rm -rf /var/lib/apt/lists/*

# ML deps for all TPU backends
# Install torch_xla first (brings libtpu 0.0.21)
RUN pip install --no-cache-dir \
    "torch==2.9.0" \
    "torch_xla[tpu]==2.9.0" \
    -f https://storage.googleapis.com/libtpu-releases/index.html

# Install jax[tpu] from libtpu releases (gets libtpu 0.0.7 + nightly — compatible with BOTH jax 0.4.38 AND torch_xla 2.9)
RUN pip install --no-cache-dir "jax[tpu]==0.4.38" -f https://storage.googleapis.com/jax-releases/libtpu_releases.html

# ML libraries
RUN pip install --no-cache-dir \
    transformers \
    "boltz==2.0.3" \
    pytorch-lightning \
    google-cloud-storage

# AlphaFold 2.3.x from GitHub
RUN pip install --no-cache-dir git+https://github.com/google-deepmind/alphafold.git@v2.3.2

# Pre-create writable dirs for TPU logs, AF2 params cache, and runtime
RUN mkdir -p /tmp/tpu_logs /var/cache/alphafold-params/params /tmp/af2-features && \
    chmod -R 777 /tmp/tpu_logs /var/cache/alphafold-params /tmp/af2-features

# Make boltz package writable for runtime monkey-patches
RUN chmod -R a+w /usr/local/lib/python3.10/dist-packages/boltz/ 2>/dev/null || true

# Create slurm user for non-root job execution
RUN groupadd -g 1015145168 slurmuser 2>/dev/null || true && \
    useradd -u 1015145168 -g 1015145168 --no-create-home --no-log-init slurmuser 2>/dev/null || true

# Bake in predict.py files
# Script to stop tpu-runtime on the host (prevents VFIO conflict)
RUN echo '#!/bin/bash\ndocker update --restart=no tpu-runtime 2>/dev/null; docker stop tpu-runtime 2>/dev/null; exit 0' > /opt/stop-tpu-runtime.sh && chmod +x /opt/stop-tpu-runtime.sh

COPY backends/af2-tpu/predict.py /opt/backends/af2-tpu/predict.py
COPY backends/esmfold-tpu/predict.py /opt/backends/esmfold-tpu/predict.py
COPY backends/boltz2-tpu/predict.py /opt/backends/boltz2-tpu/predict.py
