#!/usr/bin/env python3
"""
Fast read-only key extractor for WeChat Linux ARM64 4.1.x (WOC container).
"""
import glob
import hashlib
import hmac
import json
import os
import re
import struct
import sys
import time
from collections import Counter
from Crypto.Cipher import AES

PAGE_SIZE = 4096
SQLITE_MAGIC = b"SQLite format 3\x00"


def find_wechat_pid():
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/comm", "r") as f:
                if f.read().strip() == "wechat":
                    return int(entry)
        except OSError:
            continue
    return None


def find_wxid_dir(base="/config/xwechat_files"):
    for name in sorted(os.listdir(base)):
        if name.startswith("wxid_"):
            p = os.path.join(base, name)
            if os.path.isdir(os.path.join(p, "db_storage")):
                return name, p
    raise RuntimeError(f"No wxid_* directory with db_storage found under {base}")


def verify_sqlcipher4_raw_key(enc_key: bytes, page1: bytes) -> bool:
    if len(enc_key) != 32 or len(page1) < PAGE_SIZE:
        return False
    salt = page1[:16]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=32)
    hash_mac = hmac.new(mac_key, page1[16 : PAGE_SIZE - 64] + struct.pack("<I", 1), hashlib.sha512).digest()
    return hash_mac == page1[PAGE_SIZE - 64 : PAGE_SIZE]


def find_xor_key_from_dats(dat_paths):
    votes = Counter()
    for p in dat_paths[:50]:
        try:
            with open(p, "rb") as f:
                data = f.read()
            if len(data) < 32 or data[:6] != b"\x07\x08\x56\x32\x08\x07":
                continue
            aes_size = int.from_bytes(data[6:10], "little")
            xor_size = int.from_bytes(data[10:14], "little")
            if xor_size >= 2 and len(data) >= 15 + aes_size + xor_size:
                k1 = data[-2] ^ 0xFF
                k2 = data[-1] ^ 0xD9
                if k1 == k2:
                    votes[k1] += 1
        except OSError:
            continue
    if not votes:
        return None
    best_key, count = votes.most_common(1)[0]
    print(f"[DAT] Deduced XOR key: 0x{best_key:02x} (votes={count}/{sum(votes.values())})", flush=True)
    return best_key


def load_v2_dat_samples(dat_paths, limit=5):
    samples = []
    for p in dat_paths:
        try:
            with open(p, "rb") as f:
                hdr = f.read(31)
            if len(hdr) == 31 and hdr[:6] == b"\x07\x08\x56\x32\x08\x07":
                aes_size = int.from_bytes(hdr[6:10], "little")
                if aes_size >= 16:
                    samples.append((p, hdr[15:31]))
                    if len(samples) >= limit:
                        break
        except OSError:
            continue
    return samples


def verify_dat_aes_key(key16: bytes, dat_samples) -> bool:
    cipher = AES.new(key16, AES.MODE_ECB)
    # Fast reject on first sample
    pt0 = cipher.decrypt(dat_samples[0][1])
    if not (pt0[:3] == b"\xff\xd8\xff" or pt0[:4] == b"\x89PNG" or pt0[:4] == b"RIFF" or pt0[:4] == b"GIF8"):
        return False
    hits = 1
    for _, ct in dat_samples[1:]:
        pt = cipher.decrypt(ct)
        if pt[:3] == b"\xff\xd8\xff" or pt[:4] == b"\x89PNG" or pt[:4] == b"RIFF" or pt[:4] == b"GIF8":
            hits += 1
    return hits >= min(3, len(dat_samples))


def iter_mem_regions(pid: int):
    regions = []
    with open(f"/proc/{pid}/maps", "r") as f:
        for line in f:
            parts = line.split()
            if len(parts) < 2:
                continue
            perms = parts[1]
            if "r" not in perms or "w" not in perms:
                continue
            pathname = parts[5] if len(parts) >= 6 else ""
            if pathname.startswith("/dev/") or pathname.startswith("/memfd:"):
                continue
            start_s, end_s = parts[0].split("-")
            start, end = int(start_s, 16), int(end_s, 16)
            if end - start > 512 * 1024 * 1024:
                continue
            regions.append((start, end, pathname))
    return regions


def main():
    t0 = time.time()
    pid = find_wechat_pid()
    if not pid:
        print("ERROR: Could not find wechat process in /proc", file=sys.stderr, flush=True)
        sys.exit(1)
    print(f"[*] Found wechat PID: {pid}", flush=True)

    wxid, wxid_dir = find_wxid_dir()
    db_root = os.path.join(wxid_dir, "db_storage")
    print(f"[*] wxid: {wxid}", flush=True)

    db_info = {}
    salt_to_dbs = {}
    for db_path in sorted(glob.glob(os.path.join(db_root, "**", "*.db"), recursive=True)):
        rel = os.path.relpath(db_path, db_root)
        try:
            with open(db_path, "rb") as f:
                page1 = f.read(PAGE_SIZE)
            if len(page1) < PAGE_SIZE or page1[:16] == SQLITE_MAGIC:
                continue
            salt_hex = page1[:16].hex().lower()
            db_info[rel] = {"path": db_path, "salt": salt_hex, "page1": page1}
            salt_to_dbs.setdefault(salt_hex, []).append(rel)
        except OSError:
            continue
    print(f"[*] Loaded {len(db_info)} encrypted DBs ({len(salt_to_dbs)} unique salts)", flush=True)

    dat_paths = sorted(glob.glob(os.path.join(wxid_dir, "msg", "attach", "**", "*_t.dat"), recursive=True))
    if not dat_paths:
        dat_paths = sorted(glob.glob(os.path.join(wxid_dir, "msg", "attach", "**", "*.dat"), recursive=True))
    xor_key = find_xor_key_from_dats(dat_paths)
    dat_samples = load_v2_dat_samples(dat_paths, limit=5)
    print(f"[*] Loaded {len(dat_samples)} V2 .dat samples", flush=True)

    regions = iter_mem_regions(pid)
    total_region_mb = sum(e - s for s, e, _ in regions) / (1024 * 1024)
    print(f"[*] Scanning {len(regions)} rw-p regions (~{total_region_mb:.1f} MB)...", flush=True)

    found_db_keys = {}
    found_dat_aes_key = None
    xkey_hits_raw = 0

    pat_xkey = re.compile(rb"x\x27([0-9a-fA-F]{64})([0-9a-fA-F]{32})\x27")
    pat_hex32 = re.compile(rb"[0-9a-f]{32}")

    tested_aes = set()
    total_bytes = 0
    last_report = 0

    with open(f"/proc/{pid}/mem", "rb", buffering=0) as mem:
        for start, end, pathname in regions:
            size = end - start
            try:
                mem.seek(start)
                buf = mem.read(size)
            except OSError:
                continue
            total_bytes += len(buf)
            if total_bytes - last_report >= 100 * 1024 * 1024:
                last_report = total_bytes
                print(f"    ... scanned {total_bytes / (1024*1024):.0f} MB ({time.time()-t0:.1f}s), db_keys={len(found_db_keys)}, aes={'OK' if found_dat_aes_key else 'no'}", flush=True)

            # 1. Fast scan for x'<64hex><32hex>'
            if b"x'" in buf:
                for m in pat_xkey.finditer(buf):
                    xkey_hits_raw += 1
                    key_hex = m.group(1).decode("ascii").lower()
                    salt_hex = m.group(2).decode("ascii").lower()
                    if salt_hex in salt_to_dbs:
                        enc_key = bytes.fromhex(key_hex)
                        for rel in salt_to_dbs[salt_hex]:
                            if rel in found_db_keys:
                                continue
                            if verify_sqlcipher4_raw_key(enc_key, db_info[rel]["page1"]):
                                found_db_keys[rel] = key_hex
                                print(f"[+] VERIFIED DB KEY: {rel}", flush=True)

            # 2. Fast scan for 32-char lowercase hex candidates (V2 .dat AES key)
            if found_dat_aes_key is None and dat_samples:
                for m in pat_hex32.finditer(buf):
                    h32 = m.group(0)
                    cand_ascii = h32[:16]
                    if cand_ascii not in tested_aes:
                        tested_aes.add(cand_ascii)
                        if verify_dat_aes_key(cand_ascii, dat_samples):
                            found_dat_aes_key = cand_ascii.decode("ascii")
                            print(f"[+] VERIFIED V2 DAT AES KEY (ascii16 from hex32)!", flush=True)
                            break
                    cand_raw = bytes.fromhex(h32.decode("ascii"))
                    if cand_raw not in tested_aes:
                        tested_aes.add(cand_raw)
                        if verify_dat_aes_key(cand_raw, dat_samples):
                            found_dat_aes_key = "hex:" + cand_raw.hex()
                            print(f"[+] VERIFIED V2 DAT AES KEY (raw16 from hex32)!", flush=True)
                            break

    print(f"[*] Done in {time.time()-t0:.1f}s. Scanned {total_bytes / (1024*1024):.1f} MB (xkey regex hits={xkey_hits_raw}, aes candidates={len(tested_aes)})", flush=True)
    print(f"[*] Found DB keys: {len(found_db_keys)}/{len(db_info)}", flush=True)
    for rel in sorted(db_info.keys()):
        status = "OK" if rel in found_db_keys else "MISSING"
        print(f"    - {rel}: {status}", flush=True)
    print(f"[*] V2 DAT AES key: {'OK' if found_dat_aes_key else 'MISSING'}", flush=True)
    xor_disp = f"0x{xor_key:02x}" if xor_key is not None else "MISSING"
    print(f"[*] V2 DAT XOR key: {xor_disp}", flush=True)

    out_path = os.environ.get("KEYS_OUT", "/secrets/keys.json")
    result = {
        "wxid": wxid,
        "wechat_version": "4.1.1.8",
        "db_keys": found_db_keys,
        "dat_aes_key": found_dat_aes_key,
        "dat_xor_key": xor_key,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    os.chmod(out_path, 0o600)
    print(f"[*] Saved keys to {out_path} (mode 600)", flush=True)


if __name__ == "__main__":
    main()
