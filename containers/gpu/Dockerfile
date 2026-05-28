FROM us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# System deps
RUN apt-get update -qq && apt-get install -y -qq git gcc python3-dev && rm -rf /var/lib/apt/lists/*

# ML deps for all GPU backends
RUN pip install --no-cache-dir \
    "torch==2.6.0" --index-url https://download.pytorch.org/whl/cu124
RUN pip install --no-cache-dir \
    "jax[cuda12]==0.4.38" \
    transformers \
    "boltz==2.0.3" \
    pytorch-lightning \
    trifast \
    cuequivariance-torch \
    cuequivariance-ops-torch-cu12 \
    google-cloud-storage

# AlphaFold 2.3.x from GitHub
RUN pip install --no-cache-dir git+https://github.com/google-deepmind/alphafold.git@v2.3.2

# Pre-create writable dirs for AF2 params cache
RUN mkdir -p /var/cache/alphafold-params/params /tmp/af2-features && \
    chmod -R 777 /var/cache/alphafold-params /tmp/af2-features

# Create slurm user
RUN groupadd -g 1015145168 slurmuser 2>/dev/null || true && \
    useradd -u 1015145168 -g 1015145168 --no-create-home --no-log-init slurmuser 2>/dev/null || true

# Bake in predict.py files
COPY backends/af2-gpu/predict.py /opt/backends/af2-gpu/predict.py
COPY backends/esmfold-gpu/predict.py /opt/backends/esmfold-gpu/predict.py
COPY backends/boltz2-gpu/predict.py /opt/backends/boltz2-gpu/predict.py
