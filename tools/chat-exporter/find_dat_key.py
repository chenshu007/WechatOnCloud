#!/usr/bin/env python3
"""Unmask WeChat Linux ARM64 4.1.1.8 XOR-obfuscated V2 .dat AES key from memory."""
import glob, json, os, re, sys
from Crypto.Cipher import AES

def main():
    with open("/config/wechat/opt/wechat/wechat", "rb") as f:
        f.seek(0x1006400); m1 = f.read(16)
        f.seek(0x1004190); m2 = f.read(16)
    mask = m1 + m2

    pid = next(int(e) for e in os.listdir("/proc") if e.isdigit() and os.path.exists(f"/proc/{e}/comm") and open(f"/proc/{e}/comm").read().strip() == "wechat")
    keys_path = "/secrets/keys.json"
    keys = json.load(open(keys_path))
    wxid = keys["wxid"]
    xor_key = keys["dat_xor_key"]

    dat_paths = sorted(glob.glob(f"/config/xwechat_files/{wxid}/msg/attach/**/*_t.dat", recursive=True), reverse=True)
    samples = []
    for p in dat_paths:
        d = open(p, "rb").read()
        if len(d) >= 64 and d[:6] == b"\x07\x08\x56\x32\x08\x07" and (d[-2] ^ xor_key) == 0xFF and (d[-1] ^ xor_key) == 0xD9:
            samples.append((p, d))
            if len(samples) >= 5:
                break
    ct0 = samples[0][1][15:31]

    hex_chars = set(b"0123456789abcdef")
    allowed = [bytes(sorted(c ^ mask[i] for c in hex_chars)) for i in range(32)]
    pat = re.compile(b"".join(b"[" + re.escape(a) + b"]" for a in allowed))

    found = None
    with open(f"/proc/{pid}/maps") as mf, open(f"/proc/{pid}/mem", "rb", buffering=0) as mem:
        for line in mf:
            parts = line.split()
            if len(parts) < 2 or "r" not in parts[1] or "w" not in parts[1]:
                continue
            pname = parts[5] if len(parts) >= 6 else ""
            if pname.startswith("/dev/") or pname.startswith("/memfd:"):
                continue
            s, e = [int(x, 16) for x in parts[0].split("-")]
            if e - s > 512 * 1024 * 1024:
                continue
            try:
                mem.seek(s); buf = mem.read(e - s)
            except OSError:
                continue
            for m in pat.finditer(buf):
                obf = m.group(0)
                unmasked = bytes(obf[i] ^ mask[i] for i in range(32))
                for cand, label in [(unmasked[:16], unmasked[:16].decode()), (bytes.fromhex(unmasked.decode()), "hex:" + unmasked.decode())]:
                    if AES.new(cand, AES.MODE_ECB).decrypt(ct0)[:3] == b"\xff\xd8\xff":
                        hits = sum(1 for _, d in samples if AES.new(cand, AES.MODE_ECB).decrypt(d[15:31])[:3] == b"\xff\xd8\xff")
                        if hits >= 4:
                            found = label
                            break
                if found:
                    break
            if found:
                break

    if not found:
        print("[-] V2 DAT AES key not found", file=sys.stderr)
        sys.exit(1)

    keys["dat_aes_key"] = found
    json.dump(keys, open(keys_path, "w"), indent=2)
    os.chmod(keys_path, 0o600)
    print("[+] Verified and saved dat_aes_key to /secrets/keys.json")

if __name__ == "__main__":
    main()
