"""Benchmark ESMFold-TPU across all torch_xla execution modes.

Run on TPU node:
  PJRT_DEVICE=TPU python3 bench_modes.py

Tests:
  1. Eager mode (per-op XLA dispatch)
  2. Lazy mode (full graph compilation, no cache)
  3. Lazy mode + XLA persistent cache (second run hits cache)
  4. torch.compile(backend='openxla') with dynamo tracing
"""

import os
import subprocess
import sys
import json
import time

SEQUENCE = "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
FASTA = "/tmp/bench_esmfold.fasta"

with open(FASTA, "w") as f:
    f.write(">hemoglobin\n")
    f.write(SEQUENCE + "\n")

WORKER = '''
import os, sys, time, json
mode = sys.argv[1]
fasta = sys.argv[2]
cache_dir = sys.argv[3] if len(sys.argv) > 3 else ""

if cache_dir:
    os.environ["XLA_PERSISTENT_CACHE_PATH"] = cache_dir
    os.makedirs(cache_dir, exist_ok=True)

import torch

if mode == "eager":
    import torch_xla
    torch_xla.experimental.eager_mode(True)
    import torch_xla.core.xla_model as xm
elif mode == "lazy" or mode == "lazy_cached":
    import torch_xla
    import torch_xla.core.xla_model as xm
elif mode == "compile":
    import torch_xla
    import torch_xla.core.xla_model as xm

from transformers import AutoTokenizer, EsmForProteinFolding

device = xm.xla_device()
print(f"[{mode}] device={device}, cache={cache_dir or 'none'}", flush=True)

t_load = time.perf_counter()
tokenizer = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(device).eval()
load_ms = (time.perf_counter() - t_load) * 1000

if mode == "compile":
    t_compile = time.perf_counter()
    model = torch.compile(model, backend="openxla")
    compile_ms = (time.perf_counter() - t_compile) * 1000
    print(f"[{mode}] torch.compile took {compile_ms:.0f}ms", flush=True)

with open(fasta) as f:
    lines = f.read().strip().split("\\n")
seq = "".join(l for l in lines if not l.startswith(">"))

inputs = tokenizer(seq, return_tensors="pt", add_special_tokens=False)
inputs = {k: v.to(device) for k, v in inputs.items()}

# Run 1: cold (includes XLA compilation for lazy/compile modes)
t0 = time.perf_counter()
with torch.no_grad():
    out = model(**inputs)
xm.mark_step()
cold_ms = (time.perf_counter() - t0) * 1000
pdb = model.output_to_pdb(out)[0]
plddt = out["plddt"].cpu().numpy().flatten().mean()

# Run 2: warm (should hit XLA cache for lazy/compile modes)
inputs2 = tokenizer(seq, return_tensors="pt", add_special_tokens=False)
inputs2 = {k: v.to(device) for k, v in inputs2.items()}
t1 = time.perf_counter()
with torch.no_grad():
    out2 = model(**inputs2)
xm.mark_step()
warm_ms = (time.perf_counter() - t1) * 1000

result = {
    "mode": mode,
    "cached": bool(cache_dir),
    "load_ms": round(load_ms),
    "cold_ms": round(cold_ms),
    "warm_ms": round(warm_ms),
    "pdb_chars": len(pdb),
    "plddt": round(float(plddt), 1),
    "seq_len": len(seq),
}
print(f"RESULT:{json.dumps(result)}", flush=True)
'''

WORKER_FILE = "/tmp/bench_worker.py"
with open(WORKER_FILE, "w") as f:
    f.write(WORKER)

results = []

configs = [
    ("eager", []),
    ("lazy", []),
    ("lazy_cached", ["/var/cache/xla_bench"]),
    ("lazy_cached_warm", ["/var/cache/xla_bench"]),
    ("compile", []),
]

for mode, extra_args in configs:
    actual_mode = mode.replace("_warm", "").replace("_cached", "") if "cached" in mode else mode
    if mode == "lazy_cached_warm":
        actual_mode = "lazy"
    label = mode
    print(f"\n{'='*60}")
    print(f"Benchmarking: {label}")
    print(f"{'='*60}", flush=True)

    env = os.environ.copy()
    env["PJRT_DEVICE"] = "TPU"

    cmd = [sys.executable, WORKER_FILE, actual_mode, FASTA] + extra_args
    t_start = time.time()
    try:
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=2400)
        wall_s = time.time() - t_start
        print(proc.stdout)
        if proc.stderr:
            print(proc.stderr[-500:] if len(proc.stderr) > 500 else proc.stderr)
        for line in proc.stdout.split("\n"):
            if line.startswith("RESULT:"):
                r = json.loads(line[7:])
                r["wall_s"] = round(wall_s, 1)
                r["label"] = label
                results.append(r)
    except subprocess.TimeoutExpired:
        print(f"  TIMEOUT after 2400s")
        results.append({"label": label, "wall_s": 2400, "cold_ms": -1, "warm_ms": -1})

print(f"\n{'='*60}")
print("SUMMARY")
print(f"{'='*60}")
print(f"{'Mode':<20} {'Cold (ms)':>10} {'Warm (ms)':>10} {'Wall (s)':>10} {'pLDDT':>8}")
print("-" * 62)
for r in results:
    print(f"{r.get('label','?'):<20} {r.get('cold_ms','?'):>10} {r.get('warm_ms','?'):>10} {r.get('wall_s','?'):>10} {r.get('plddt','?'):>8}")
