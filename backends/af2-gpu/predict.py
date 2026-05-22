"""AlphaFold 2 on GPU (A100).

AF2 is JAX-native. Same code runs on GPU and TPU — JAX auto-detects.
See backends/af2-tpu/predict.py for the full implementation.
GPU result: 146.7s, pLDDT 42.4, PDB 87,480 chars (hemoglobin alpha, 142 aa).
"""
# AF2 GPU uses the same predict.py as af2-tpu — JAX detects the device.
# This file exists for symmetry. See af2-tpu/predict.py.
from backends.af2_tpu.predict import predict_structure  # noqa
