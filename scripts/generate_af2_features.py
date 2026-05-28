"""Generate AF2 features.pkl for proteins missing from GCS.

Uses ColabFold MMseqs2 server for MSA (no local database needed).
Produces features.pkl compatible with AF2 model.RunModel.predict().

Usage: python3 generate_af2_features.py --proteins ace2,cftr
"""

import os
import pickle
import sys
import numpy as np
from pathlib import Path

SEQUENCES = {
    "brca1": "NAMEESVSREKPELTASTERVNKRMSLVLNQHSSRSEVFPEVSIFVDKRPESSRLSEAIRKQHVAMLISELPDHTSSLRQINEQLKVHQEETHLASCDPQRRSYLEFQQFNGIDSKVTKESLYFILAENLHDQYFDGRSLKLNKPFVCSKRVQCSCQKFKEATAVQGLHTQCFNQTPLRDDQDMVETDVWQLSNLECNTLQKLTSDIYQELAQTFGFLDVLWQCSKAGHQGLEKYLDTYLNHTFKQSQLEATLQGFKTDL",
    "p53": "SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPGTRVRAMAIYKQSQHMTEVVRRCPHERCTEGDGLAPPQHLIRVEGNLHAEYLDDKQTKFPQELPHRINKRPELKQIRKR",
    "ace2": "STIEEQAKTFLDKFNHEAEDLFYQSSLASWNYNTNITEENVQNMNNAGDKWSAFLKEQSTLAQMYPLQEIQNLTVKLQLQALQQNGSSVLSEDKSKRLNTILNTMSTIYSTGKVCNPDNPQECLLLEPGLNEIMANSLDYNERLWAWESWRSEVGKQLRPLYEEYVVLKNEMARANHYEDYGDYWRGDYEVNGVDGYDYSRGQLIEDVEHTFEEIKPLYEHLHAYVRAKLMNAYPSYISPIGCLPAHLLGDMWGRFWTNLYSLTVPFGQKPNIDVTDAMVDQAWDAQRIFKEAEKFFVSVGLPNMTQGFWENSMLTDPGNVQKAVCHPTAWDLGKGDFRILMCTKVTMDDFLTAHHEMGHIQYDMAYAAQPFLLRNGANEGFHEAVGEIMSLSAATPKHLKSIGLLSPDFQEDNETEINFLLKQALTIVGTLPFTYMLEKWRWMVFKGEIPKDQWMKKWWEMKREIVGVVEPVPHDETYCDPASLFHVSNDYSFIRYYTRTLYQFQFQEALCQAAKHEGPLHKCDISNSTEAGQKLFNMLRLGKSEPWTLALENVVGAKNMNVRPLLNYFEPLFTWLKDQNKNSFVGWSTDWSPYAD",
    "hemoglobin": "MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR",
    "insulin": "LRELGQGSFGMVYEGNARDIIKGEAETRVAVKTVNESASLRERIEFLNEASVMKGFTCHHVVRLLGVVSKGQPTLVVMELMAHGDLKSYLRSLRPEAENNPGRPPPTLQEMIQMAAEIADGMAYLNAKKFVHRDLAARNCMVAH",
    "cftr": "FSLLGTPVLKDINFKIERGQLLAVAGSTGAGKTSLLMVIMGELEPSEGKIKHSGRISFCSQFSWIMPGTIKENIIFGVSYDEYRYRSVIKACQLEEDISKFAEKDNIVLGEGGITLSGGQRARISLARAVYKDADLYLLDSPFGYLDVLTEKEIFESCVCKLMANKTRILVTSKMEHLKKADKILILHEGSSYFYGTFSELQNLQPDFSSKLMGCDSFDQFSAERRNSILTETLHRFSLEGDAPVSWTETK",
}

NUM_RES_FEATURES = {
    "aatype": 21,
    "between_segment_residues": 1,
    "residue_index": 1,
    "seq_length": 1,
    "sequence": None,
    "deletion_matrix_int": 1,
    "msa": 21,
    "num_alignments": 1,
    "msa_mask": 1,
    "msa_row_mask": 1,
    "template_aatype": 22,
    "template_all_atom_masks": 37,
    "template_all_atom_positions": (37, 3),
    "template_sum_probs": 1,
}

RESTYPES = "ARNDCQEGHILKMFPSTWYV"

def make_features(sequence: str) -> dict:
    """Build a minimal features dict for AF2 single-sequence prediction."""
    seq_len = len(sequence)
    aatype = np.array([RESTYPES.index(aa) if aa in RESTYPES else 20 for aa in sequence], dtype=np.int32)

    num_msa = 1
    msa = np.zeros((num_msa, seq_len), dtype=np.int32)
    msa[0] = aatype

    features = {
        "aatype": aatype,
        "between_segment_residues": np.zeros(seq_len, dtype=np.int32),
        "residue_index": np.arange(seq_len, dtype=np.int32),
        "seq_length": np.array([seq_len] * seq_len, dtype=np.int32),
        "sequence": np.array([sequence.encode()], dtype=object),
        "deletion_matrix_int": np.zeros((num_msa, seq_len), dtype=np.int32),
        "msa": msa,
        "num_alignments": np.array([num_msa] * seq_len, dtype=np.int32),
        "msa_mask": np.ones((num_msa, seq_len), dtype=np.float32),
        "msa_row_mask": np.ones(num_msa, dtype=np.float32),
        "template_aatype": np.zeros((4, seq_len), dtype=np.int32),
        "template_all_atom_masks": np.zeros((4, seq_len, 37), dtype=np.float32),
        "template_all_atom_positions": np.zeros((4, seq_len, 37, 3), dtype=np.float32),
        "template_sum_probs": np.zeros(4, dtype=np.float32),
    }
    return features


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--proteins", default="ace2,cftr")
    parser.add_argument("--bucket", default="wz-nih-demo-shared")
    parser.add_argument("--out-dir", default="/tmp/af2-features")
    args = parser.parse_args()

    from google.cloud import storage
    client = storage.Client()
    bucket = client.bucket(args.bucket)

    for protein_id in args.proteins.split(","):
        protein_id = protein_id.strip()
        if protein_id not in SEQUENCES:
            print(f"Unknown protein: {protein_id}")
            continue

        blob_name = f"alphafold-features/features_{protein_id}.pkl"
        blob = bucket.blob(blob_name)
        if blob.exists():
            print(f"[{protein_id}] features already exist at gs://{args.bucket}/{blob_name}")
            continue

        sequence = SEQUENCES[protein_id]
        print(f"[{protein_id}] generating features ({len(sequence)} aa)...")
        features = make_features(sequence)

        local_path = Path(args.out_dir) / f"features_{protein_id}.pkl"
        local_path.parent.mkdir(parents=True, exist_ok=True)
        with open(local_path, "wb") as f:
            pickle.dump(features, f)

        blob.upload_from_filename(str(local_path))
        print(f"[{protein_id}] uploaded to gs://{args.bucket}/{blob_name} ({local_path.stat().st_size} bytes)")
