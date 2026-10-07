#!/usr/bin/env python3
"""Publish the burst partitions as JSON, once a minute from root's crontab on the controller.

A researcher's tools read this to see what the cluster can run before they submit, such as a coding
agent's skill on a Cloud Workstation. Sources, all on the controller:

    sinfo                       each node's partitions, state and features, live
    /etc/slurm/cloud.conf       which nodesets make up each partition
    /slurm/scripts/config.yaml  each nodeset's zones, TPU type and Spot setting (slurm-gcp; root only)

Writes gs://$SHARED_BUCKET_NAME/cluster/partitions.json with the controller's service account,
Cache-Control no-store, so the public URL never serves a stale copy.

    * * * * * /usr/bin/python3 /opt/protein-demo/publish_partitions.py >> /var/log/publish_partitions.log 2>&1
"""
import datetime
import json
import os
import subprocess
import urllib.request

import yaml

BUCKET = os.environ.get("SHARED_BUCKET_NAME", "wz-nih-demo-shared")
OBJECT = "cluster/partitions.json"
# slurm-gcp installs Slurm under /usr/local. The distro's older /usr/bin/sinfo comes first on cron's PATH
# and fails with "Incompatible versions of client and server code".
SINFO = "/usr/local/bin/sinfo" if os.path.exists("/usr/local/bin/sinfo") else "sinfo"
# sinfo's state suffixes for cloud nodes, in plain words.
SUFFIX = {"~": "powered down", "#": "powering up", "%": "powering down", "*": "not responding", "!": "pending power down"}


def kv(line):
    """Slurm config line "Key=Value Key2=Value2" as a dict."""
    out = {}
    for token in line.split():
        if "=" in token:
            k, v = token.split("=", 1)
            out[k] = v
    return out


def node_state(raw):
    base, flags = raw, []
    while base and base[-1] in SUFFIX:
        flags.append(SUFFIX[base[-1]])
        base = base[:-1]
    if "powered down" in flags:
        return "powered down"
    if "not responding" in flags:
        return "not responding"
    if flags:
        return flags[0]
    return {"idle": "idle", "allocated": "busy", "mixed": "busy", "completing": "busy"}.get(base, base)


def main():
    nodes = {}
    out = subprocess.run([SINFO, "-h", "-N", "-o", "%N|%P|%T|%f"], capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        name, part, state, feats = line.split("|")
        n = nodes.setdefault(name, {"partitions": [], "state": node_state(state), "features": feats.split(",")})
        if part.rstrip("*") not in n["partitions"]:
            n["partitions"].append(part.rstrip("*"))

    nodesets, partitions = {}, []
    with open("/etc/slurm/cloud.conf") as f:
        for line in f:
            if line.startswith("NodeSet="):
                d = kv(line)
                nodesets[d["NodeSet"]] = {"nodes": d["Nodes"]}
            elif line.startswith("PartitionName="):
                d = kv(line)
                partitions.append({"name": d["PartitionName"], "default": d.get("Default") == "YES",
                                   "nodesets": d["Nodes"].split(",")})

    with open("/slurm/scripts/config.yaml") as f:
        cfg = yaml.safe_load(f)
    for name, ns in (cfg.get("nodeset") or {}).items():
        if name in nodesets:
            nodesets[name].update(zones=ns.get("zone_policy_allow") or [], tpu_type=None, preemptible=None)
    for name, ns in (cfg.get("nodeset_tpu") or {}).items():
        if name in nodesets:
            nodesets[name].update(zones=[ns["zone"]] if ns.get("zone") else [], tpu_type=ns.get("node_type"),
                                  preemptible=bool(ns.get("preemptible")))

    result = []
    for p in partitions:
        sets = []
        for ns_name in p["nodesets"]:
            ns = nodesets.get(ns_name, {})
            members = [n for n, d in nodes.items() if p["name"] in d["partitions"] and n.startswith(f"{cfg.get('slurm_cluster_name', '')}-{ns_name}-")]
            states = {}
            for n in members:
                states[nodes[n]["state"]] = states.get(nodes[n]["state"], 0) + 1
            feats = sorted({f for n in members for f in nodes[n]["features"]})
            spot = "spot" in feats if ns.get("preemptible") is None else ns["preemptible"]
            accel = f"TPU {ns['tpu_type']}" if ns.get("tpu_type") else ("A100 40GB" if "a100" in feats else ",".join(feats))
            sets.append({"nodeset": ns_name, "accelerator": accel, "spot": spot, "zones": ns.get("zones", []),
                         "nodes": len(members), "states": states})
        result.append({"partition": p["name"], "default": p["default"], "nodesets": sets})

    doc = {"updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "cluster": cfg.get("slurm_cluster_name"), "partitions": result}
    body = json.dumps(doc, indent=1).encode()
    tok = json.loads(urllib.request.urlopen(urllib.request.Request(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        headers={"Metadata-Flavor": "Google"}), timeout=5).read())["access_token"]
    meta = json.dumps({"name": OBJECT, "contentType": "application/json", "cacheControl": "no-store"})
    boundary = "partitions-boundary"
    data = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n"
            f"--{boundary}\r\nContent-Type: application/json\r\n\r\n").encode() + body + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"https://storage.googleapis.com/upload/storage/v1/b/{BUCKET}/o?uploadType=multipart",
                                 data=data, method="POST",
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": f"multipart/related; boundary={boundary}"})
    urllib.request.urlopen(req, timeout=20).read()
    print(doc["updated"], json.dumps([(p["partition"], [(s["nodeset"], s["states"]) for s in p["nodesets"]]) for p in result]))


if __name__ == "__main__":
    main()
