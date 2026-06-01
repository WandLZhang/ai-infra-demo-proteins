#!/bin/bash
# prewarm_all_proteins.sh — Send one inference call for each of the 6 demo
# proteins to BOTH warm TPU servers (ESMFold on east5a-0:8090, Boltz-2 on
# east5a-3:8091). Eager-mode XLA compiles per-shape on first call, so a fresh
# server has every shape cold until it's been seen once. This script pays
# that cost up-front so any press-Enter during the demo hits warm cache.
#
# Run on the east5a-0 host (or via gcloud ssh into it). Boltz-2 calls go
# over the internal network to 10.202.0.23.
#
# Expected wall-clock on a fresh server:
#   ESMFold: 6 shapes × ~70s = ~7 min
#   Boltz-2: 6 shapes × ~60s = ~6 min
# Total in parallel: ~7 min.
#
# Usage:
#   bash prewarm_all_proteins.sh

set -uo pipefail

ESM_URL="http://localhost:8090/predict"
BOLTZ_URL="http://10.202.0.23:8091/predict"
SENTINEL="/tmp/tpu-prewarm-done"
PIDFILE="/tmp/tpu-prewarm.pid"
STATUS_BLOB="gs://wz-nih-demo-shared/tpu-status.json"

# Pid-file based mutex (pgrep self-matches because keep-warm's bash -c
# command line contains "prewarm_all_proteins.sh" — caused every cron
# run to skip silently for hours). Check + write our own pid + cleanup on exit.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then
  echo "$(date) prewarm SKIP: another instance running pid=$(cat $PIDFILE)"
  exit 0
fi
echo $$ > "$PIDFILE"
trap "rm -f $PIDFILE" EXIT INT TERM

# Do NOT delete the sentinel here. The sentinel's mtime is the SOLE truth
# source for "last time all 12 shapes were touched". If we deleted it at
# start, the badge would lie about warmth during the prewarm cycle itself
# (sentinel briefly missing → badge=loading even though most shapes are
# still hot from the previous cycle). Letting the old mtime persist until
# the new `touch` overwrites it at end means: sentinel age = age of last
# SUCCESSFUL warm-up. Health cron compares this age to its threshold.

# Sequences (must match run_backend.sh)
declare -A SEQ
SEQ[brca1]="NAMEESVSREKPELTASTERVNKRMSLVLNQHSSRSEVFPEVSIFVDKRPESSRLSEAIRKQHVAMLISELPDHTSSLRQINEQLKVHQEETHLASCDPQRRSYLEFQQFNGIDSKVTKESLYFILAENLHDQYFDGRSLKLNKPFVCSKRVQCSCQKFKEATAVQGLHTQCFNQTPLRDDQDMVETDVWQLSNLECNTLQKLTSDIYQELAQTFGFLDVLWQCSKAGHQGLEKYLDTYLNHTFKQSQLEATLQGFKTDL"
SEQ[p53]="SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPGTRVRAMAIYKQSQHMTEVVRRCPHERCTEGDGLAPPQHLIRVEGNLHAEYLDDKQTKFPQELPHRINKRPELKQIRKR"
SEQ[ace2]="STIEEQAKTFLDKFNHEAEDLFYQSSLASWNYNTNITEENVQNMNNAGDKWSAFLKEQSTLAQMYPLQEIQNLTVKLQLQALQQNGSSVLSEDKSKRLNTILNTMSTIYSTGKVCNPDNPQECLLLEPGLNEIMANSLDYNERLWAWESWRSEVGKQLRPLYEEYVVLKNEMARANHYEDYGDYWRGDYEVNGVDGYDYSRGQLIEDVEHTFEEIKPLYEHLHAYVRAKLMNAYPSYISPIGCLPAHLLGDMWGRFWTNLYSLTVPFGQKPNIDVTDAMVDQAWDAQRIFKEAEKFFVSVGLPNMTQGFWENSMLTDPGNVQKAVCHPTAWDLGKGDFRILMCTKVTMDDFLTAHHEMGHIQYDMAYAAQPFLLRNGANEGFHEAVGEIMSLSAATPKHLKSIGLLSPDFQEDNETEINFLLKQALTIVGTLPFTYMLEKWRWMVFKGEIPKDQWMKKWWEMKREIVGVVEPVPHDETYCDPASLFHVSNDYSFIRYYTRTLYQFQFQEALCQAAKHEGPLHKCDISNSTEAGQKLFNMLRLGKSEPWTLALENVVGAKNMNVRPLLNYFEPLFTWLKDQNKNSFVGWSTDWSPYAD"
SEQ[hemoglobin]="MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
SEQ[insulin]="LRELGQGSFGMVYEGNARDIIKGEAETRVAVKTVNESASLRERIEFLNEASVMKGFTCHHVVRLLGVVSKGQPTLVVMELMAHGDLKSYLRSLRPEAENNPGRPPPTLQEMIQMAAEIADGMAYLNAKKFVHRDLAARNCMVAH"
SEQ[cftr]="FSLLGTPVLKDINFKIERGQLLAVAGSTGAGKTSLLMVIMGELEPSEGKIKHSGRISFCSQFSWIMPGTIKENIIFGVSYDEYRYRSVIKACQLEEDISKFAEKDNIVLGEGGITLSGGQRARISLARAVYKDADLYLLDSPFGYLDVLTEKEIFESCVCKLMANKTRILVTSKMEHLKKADKILILHEGSSYFYGTFSELQNLQPDFSSKLMGCDSFDQFSAERRNSILTETLHRFSLEGDAPVSWTETK"

# BRCA1-only: the talk track defaults to brca1 and warming 6 shapes evicted
# each other under HBM pressure on the v6e-4 (the very thing we were trying
# to prevent). Switching to anything else in the demo costs a one-time cold
# compile on first press (~66s ESMFold, ~125s Boltz-2). Worth it for a
# rock-solid warm cycle on the actual demo protein.
PROTEINS=(brca1)

echo "===== Pre-warming ESMFold ($ESM_URL) ====="
# X-Keepwarm: true tells the server these are low-priority — a real Slurm
# POST (no header) will jump the queue and only wait for the current shape
# to finish, not all 6.
for P in "${PROTEINS[@]}"; do
  T0=$(date +%s)
  RESP=$(curl -s -m 300 -X POST \
    -H "Content-Type: application/json" \
    -H "X-Keepwarm: true" \
    -d "{\"sequence\":\"${SEQ[$P]}\",\"out_path\":\"/tmp/prewarm_esm_${P}.pdb\"}" \
    "$ESM_URL")
  T1=$(date +%s)
  OK=$(echo "$RESP" | grep -c pdb_path)
  printf "  %-12s %3ds  ok=%s  %s\n" "$P" "$((T1-T0))" "$OK" "$(echo "$RESP" | head -c 100)"
done

echo ""
echo "===== Pre-warming Boltz-2 ($BOLTZ_URL) ====="
# Use Python for the Boltz-2 calls — bash heredoc/escaping inside docker exec
# inside ssh inside gcloud chains is unreliable for embedded newlines.
python3 <<PYEOF
import json, time, urllib.request, urllib.error
# brca1-only (matches the bash PROTEINS list above). If you change PROTEINS,
# change this list too — they are NOT linked.
proteins = [
    ("brca1",      """${SEQ[brca1]}"""),
]
for name, seq in proteins:
    fasta = f">A|protein\n{seq}\n"
    payload = json.dumps({
        "fasta_content": fasta,
        "name": f"prewarm_{name}",
        "out_dir": f"/tmp/prewarm_boltz_{name}",
        "sampling_steps": 10,
    }).encode()
    req = urllib.request.Request(
        "$BOLTZ_URL",
        data=payload,
        headers={"Content-Type": "application/json", "X-Keepwarm": "true"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
        cif = d.get("cif_chars", 0)
        err = ""
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
        cif = 0
        err = f"  ERR: {type(e).__name__}: {e}"
    elapsed = int(time.time() - t0)
    print(f"  {name:<12} {elapsed:3d}s  cif_chars={cif}{err}")
PYEOF

echo ""
echo "Done. Marking ready."
touch "$SENTINEL"
echo '{"status":"ready"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null || true
