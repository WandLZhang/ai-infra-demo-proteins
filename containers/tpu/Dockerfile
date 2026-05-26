FROM us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# System deps
RUN apt-get update -qq && apt-get install -y -qq git libpython3.10 && rm -rf /var/lib/apt/lists/*

# ML deps for all TPU backends
RUN pip install --no-cache-dir \
    "torch==2.9.0" \
    "torch_xla[tpu]==2.9.0" \
    "jax[tpu]==0.4.38" \
    transformers \
    "boltz==2.0.3" \
    pytorch-lightning \
    google-cloud-storage \
    -f https://storage.googleapis.com/libtpu-releases/index.html \
    -f https://storage.googleapis.com/jax-releases/libtpu_releases.html

# AlphaFold 2.3.x from GitHub
RUN pip install --no-cache-dir git+https://github.com/google-deepmind/alphafold.git@v2.3.2

# Make boltz package writable for runtime monkey-patches
RUN chmod -R a+w /usr/local/lib/python3.10/dist-packages/boltz/ 2>/dev/null || true

# Create slurm user for non-root job execution
RUN groupadd -g 1015145168 slurmuser 2>/dev/null || true && \
    useradd -u 1015145168 -g 1015145168 -m -d /tmp/slurmhome slurmuser 2>/dev/null || true

# Bake in predict.py files
COPY backends/af2-tpu/predict.py /opt/backends/af2-tpu/predict.py
COPY backends/esmfold-tpu/predict.py /opt/backends/esmfold-tpu/predict.py
COPY backends/boltz2-tpu/predict.py /opt/backends/boltz2-tpu/predict.py
