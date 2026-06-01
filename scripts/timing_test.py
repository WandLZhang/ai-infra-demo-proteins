"""Pre-run checklist helper: time one warm ESMFold POST for hemoglobin.

Run inside the slurmd container on east5a-0:
  docker exec slurmd python3 /tmp/timing_test.py

Expect: wall <20s, warm=True
"""
import json, time, urllib.request

HEMOGLOBIN = (
    "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHV"
    "DDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
)

data = json.dumps({"sequence": HEMOGLOBIN, "out_path": "/tmp/check.pdb"}).encode()
req = urllib.request.Request(
    "http://localhost:8090/predict",
    data=data,
    headers={"Content-Type": "application/json"},
)
t0 = time.time()
with urllib.request.urlopen(req, timeout=60) as r:
    d = json.loads(r.read())
wall = time.time() - t0
print(f"wall={wall:.1f}s solve_ms={d['solve_time_ms']} warm={d['warm']}")
