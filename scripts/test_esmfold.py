"""Unified ESMFold test — identical code, different silicon.

Usage:
  python test_esmfold.py              # auto-detect (TPU if available, else GPU, else CPU)
  python test_esmfold.py --device gpu
  python test_esmfold.py --device tpu
"""

import argparse
import time
import sys

SEQUENCE = "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"

def get_device(requested: str):
    if requested == "tpu":
        import torch_xla.core.xla_model as xm
        device = xm.xla_device()
        print(f"Device: TPU ({device})")
        return device, "tpu"

    import torch
    if requested == "gpu" or (requested == "auto" and torch.cuda.is_available()):
        device = torch.device("cuda")
        print(f"Device: GPU ({torch.cuda.get_device_name(0)})")
        return device, "gpu"

    device = torch.device("cpu")
    print(f"Device: CPU")
    return device, "cpu"


def run(device_name: str):
    import torch
    from transformers import AutoTokenizer, EsmForProteinFolding

    device, dtype = get_device(device_name)

    print(f"Loading facebook/esmfold_v1...")
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
    model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1")
    model = model.to(device)
    model.eval()
    load_time = time.perf_counter() - t0
    print(f"Model loaded in {load_time:.1f}s")

    print(f"\nPredicting structure for hemoglobin alpha ({len(SEQUENCE)} aa)...")
    inputs = tokenizer(SEQUENCE, return_tensors="pt", add_special_tokens=False)
    inputs = {k: v.to(device) for k, v in inputs.items()}

    t1 = time.perf_counter()
    with torch.no_grad():
        output = model(**inputs)
    if dtype == "tpu":
        import torch_xla.core.xla_model as xm
        xm.mark_step()
    infer_time = time.perf_counter() - t1

    pdb_str = model.output_to_pdb(output)[0]
    plddt = output["plddt"].cpu().numpy().flatten()

    print(f"\n{'='*50}")
    print(f"RESULT")
    print(f"{'='*50}")
    print(f"  Device:       {dtype.upper()}")
    print(f"  Sequence:     Hemoglobin alpha ({len(SEQUENCE)} aa)")
    print(f"  Load time:    {load_time:.1f}s")
    print(f"  Infer time:   {infer_time:.1f}s")
    print(f"  pLDDT mean:   {plddt.mean():.1f}")
    print(f"  pLDDT range:  [{plddt.min():.1f}, {plddt.max():.1f}]")
    print(f"  PDB length:   {len(pdb_str)} chars")
    print(f"  PDB preview:  {pdb_str[:80]}...")
    print(f"{'='*50}")
    print(f"GATE: {'PASS' if plddt.mean() > 50 else 'FAIL'} (pLDDT {plddt.mean():.1f} {'>' if plddt.mean() > 50 else '<='} 50)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["auto", "gpu", "tpu", "cpu"], default="auto")
    args = parser.parse_args()
    run(args.device)
