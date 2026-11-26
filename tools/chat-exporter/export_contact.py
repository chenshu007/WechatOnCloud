#!/usr/bin/env python3
"""
Manual, read-only, specified-contact WeChat 4.1.x chat exporter for AI Agent analysis.
Outputs self-contained contact bundle:
  /output/<safe_name>_<short_id>/
    messages.jsonl
    images/
    manifest.json
Directory permissions: 750, file permissions: 640, owner: EXPORT_UID:EXPORT_GID (default 1000:10).
"""
import argparse
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import pilk
import zstandard
from Crypto.Cipher import AES

TZ_SHANGHAI = datetime.timezone(datetime.timedelta(hours=8))
ZSTD = zstandard.ZstdDecompressor()


def get_owner_ids():
    uid = int(os.environ.get("EXPORT_UID", "1000"))
    gid = int(os.environ.get("EXPORT_GID", "10"))
    return uid, gid


def apply_perms(path: str, is_dir: bool = False):
    uid, gid = get_owner_ids()
    try:
        os.chown(path, uid, gid)
    except PermissionError:
        pass
    os.chmod(path, 0o750 if is_dir else 0o640)


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)
    apply_perms(path, is_dir=True)


def decrypt_db_snapshot(db_root: str, rel_path: str, key_hex: str, work_dir: str) -> str:
    src = os.path.join(db_root, rel_path)
    if not os.path.exists(src):
        return ""
    safe_base = rel_path.replace("/", "__")
    snap_dir = os.path.join(work_dir, "snap")
    plain_dir = os.path.join(work_dir, "plain")
    os.makedirs(snap_dir, exist_ok=True)
    os.makedirs(plain_dir, exist_ok=True)

    dst_snap = os.path.join(snap_dir, safe_base)
    for ext in ("", "-wal", "-shm"):
        if os.path.exists(src + ext):
            shutil.copy2(src + ext, dst_snap + ext)

    salt_hex = open(dst_snap, "rb").read(16).hex()
    dst_plain = os.path.join(plain_dir, safe_base)
    sql = (
        f'PRAGMA key = "x\'{key_hex}{salt_hex}\'";\n'
        "PRAGMA cipher_compatibility = 4;\n"
        f"ATTACH DATABASE '{dst_plain}' AS plaintext KEY '';\n"
        "SELECT sqlcipher_export('plaintext');\n"
        "DETACH DATABASE plaintext;\n"
    )
    proc = subprocess.run(["sqlcipher", dst_snap], input=sql, text=True, capture_output=True)
    if proc.returncode != 0 or not os.path.exists(dst_plain):
        raise RuntimeError(f"Failed to decrypt {rel_path}: {proc.stderr.strip()}")
    return dst_plain


def decompress_field(val, ct_flag):
    if val is None:
        return ""
    if isinstance(val, str):
        return val
    if isinstance(val, (bytes, bytearray)):
        if ct_flag == 4:
            try:
                return ZSTD.decompress(bytes(val)).decode("utf-8", errors="replace")
            except Exception:
                pass
        return bytes(val).decode("utf-8", errors="replace")
    return str(val)


def detect_img_ext(data: bytes) -> str:
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ".bin"


def decrypt_dat_bytes(data: bytes, aes_key_str: str | None, xor_key: int | None) -> bytes | None:
    if len(data) < 16:
        return None
    # Plain image already?
    if detect_img_ext(data) != ".bin":
        return data
    # WeChat 4.x V2 .dat
    if data[:6] == b"\x07\x08\x56\x32\x08\x07":
        if not aes_key_str or xor_key is None:
            return None
        aes_key = bytes.fromhex(aes_key_str[4:]) if aes_key_str.startswith("hex:") else aes_key_str.encode("ascii")
        aes_size = int.from_bytes(data[6:10], "little")
        xor_size = int.from_bytes(data[10:14], "little")
        aes_padded = (aes_size // 16 + 1) * 16
        body = data[15:]
        if len(body) < aes_padded:
            return None
        cipher = AES.new(aes_key, AES.MODE_ECB)
        aes_dec = cipher.decrypt(body[:aes_padded])
        pad_len = aes_dec[-1]
        if 1 <= pad_len <= 16 and aes_dec.endswith(bytes([pad_len]) * pad_len):
            aes_plain = aes_dec[:-pad_len]
        else:
            aes_plain = aes_dec[:aes_size]
        rem = body[aes_padded:]
        if xor_size > 0 and len(rem) >= xor_size:
            plain_mid = rem[:-xor_size]
            xor_tail = bytes(b ^ xor_key for b in rem[-xor_size:])
        else:
            plain_mid = rem
            xor_tail = b""
        out = aes_plain + plain_mid + xor_tail
        return out if detect_img_ext(out) != ".bin" else None

    # WeChat V1 .dat (07 08 V1 08 07) or legacy single-byte XOR
    if xor_key is not None:
        out = bytes(b ^ xor_key for b in data)
        if detect_img_ext(out) != ".bin":
            return out
    # Auto-detect single-byte XOR against JPEG/PNG/GIF
    for magic in (b"\xff\xd8\xff", b"\x89PNG", b"GIF8"):
        k = data[0] ^ magic[0]
        if all((data[i] ^ k) == magic[i] for i in range(len(magic))):
            return bytes(b ^ k for b in data)
    return None


def parse_xml_safe(xml_str: str):
    if not xml_str:
        return None
    s = xml_str.strip()
    idx = s.find("<")
    if idx > 0:
        s = s[idx:]
    try:
        return ET.fromstring(s)
    except ET.ParseError:
        return None


def parse_appmsg(xml_str: str, sub_type: int) -> dict:
    root = parse_xml_safe(xml_str)
    if root is None:
        return {"type": "appmsg", "sub_type": sub_type, "content": xml_str[:300]}
    appmsg = root.find("appmsg")
    if appmsg is None:
        return {"type": "appmsg", "sub_type": sub_type, "content": xml_str[:300]}

    def gt(elem, tag):
        c = elem.find(tag)
        return (c.text or "").strip() if c is not None else ""

    title = gt(appmsg, "title")
    des = gt(appmsg, "des")
    url = gt(appmsg, "url")
    app_type = gt(appmsg, "type") or str(sub_type)

    # Quote reply (sub_type == 57)
    if str(app_type) == "57" or sub_type == 57:
        refer = appmsg.find("refermsg")
        quote = {}
        if refer is not None:
            quote = {
                "sender_name": gt(refer, "displayname"),
                "sender": gt(refer, "chatusr"),
                "msg_type": gt(refer, "type"),
                "svr_id": gt(refer, "svrid"),
                "content": gt(refer, "content")[:500],
            }
        return {"type": "text", "content": title, "quote": quote}

    # Transfer (2000) / Red envelope (2001)
    if str(app_type) == "2000":
        wcpay = appmsg.find("wcpayinfo")
        return {
            "type": "transfer",
            "content": title or "[转账]",
            "transfer": {
                "fee_desc": gt(wcpay, "feedesc") if wcpay is not None else "",
                "pay_memo": gt(wcpay, "pay_memo") if wcpay is not None else "",
                "pay_subtype": gt(wcpay, "paysubtype") if wcpay is not None else "",
            },
        }
    if str(app_type) == "2001":
        wcpay = appmsg.find("wcpayinfo")
        return {
            "type": "red_envelope",
            "content": gt(wcpay, "sendertitle") if wcpay is not None else (title or "[红包]"),
        }

    # File (6)
    if str(app_type) == "6":
        attach = appmsg.find("appattach")
        return {
            "type": "file",
            "content": f"[文件] {title}",
            "file_name": title,
            "file_size": gt(attach, "totallen") if attach is not None else "",
            "file_ext": gt(attach, "fileext") if attach is not None else "",
        }

    # Link / Article / Mini-program / Channels
    meta = {"app_type": app_type, "title": title}
    if des:
        meta["description"] = des
    if url:
        meta["url"] = url
    return {"type": "link" if url else "appmsg", "content": title or f"[卡片:{app_type}]", "meta": meta}


def parse_emoji(xml_str: str) -> dict:
    root = parse_xml_safe(xml_str)
    desc = ""
    md5 = ""
    if root is not None:
        em = root.find("emoji")
        if em is not None:
            md5 = em.attrib.get("md5", "")
            desc = em.attrib.get("desc", "") or em.attrib.get("cdnurl", "")
    return {"type": "emoji", "content": f"[表情] {desc}".strip() if desc and not desc.startswith("http") else "[表情]", "emoji_md5": md5}


def parse_image_xml(xml_str: str) -> dict:
    root = parse_xml_safe(xml_str)
    md5 = ""
    if root is not None:
        img = root.find("img")
        if img is not None:
            md5 = img.attrib.get("md5", "").lower()
    return {"md5": md5}


def parse_voice_xml(xml_str: str) -> int:
    root = parse_xml_safe(xml_str)
    if root is not None:
        vm = root.find("voicemsg")
        if vm is not None:
            try:
                return int(vm.attrib.get("voicelength", "0"))
            except ValueError:
                pass
    return 0


class GeminiSTT:
    def __init__(self, cache_path: str, enabled: bool = True):
        self.cache_path = cache_path
        self.enabled = enabled
        self.model = os.environ.get("GEMINI_STT_MODEL", "gemini-2.5-flash")
        self.api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        self.cache = {}
        self.client = None
        self.stats = {"cached": 0, "transcribed": 0, "skipped": 0, "failed": 0}
        if os.path.exists(cache_path):
            try:
                self.cache = json.load(open(cache_path, "r", encoding="utf-8"))
            except Exception:
                self.cache = {}
        if self.enabled and self.api_key:
            from google import genai
            self.client = genai.Client(api_key=self.api_key)
        elif self.enabled and not self.api_key:
            print("[WARN] GEMINI_API_KEY not set; voice STT will be skipped.", file=sys.stderr, flush=True)
            self.enabled = False

    def save_cache(self):
        ensure_dir(os.path.dirname(self.cache_path))
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump(self.cache, f, ensure_ascii=False, indent=2)
        apply_perms(self.cache_path, is_dir=False)

    def transcribe_silk(self, silk_bytes: bytes, tmp_dir: str) -> tuple[str | None, str]:
        if not silk_bytes:
            self.stats["skipped"] += 1
            return None, "missing_audio"
        h = hashlib.sha256(silk_bytes).hexdigest()
        if h in self.cache:
            self.stats["cached"] += 1
            return self.cache[h].get("text", ""), self.cache[h].get("model", self.model)
        if not self.enabled or not self.client:
            self.stats["skipped"] += 1
            return None, "stt_disabled"

        silk_p = os.path.join(tmp_dir, f"{h}.silk")
        pcm_p = os.path.join(tmp_dir, f"{h}.pcm")
        wav_p = os.path.join(tmp_dir, f"{h}.wav")
        try:
            with open(silk_p, "wb") as f:
                f.write(silk_bytes)
            pilk.decode(silk_p, pcm_p)
            subprocess.run(
                ["ffmpeg", "-y", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm_p, "-ar", "16000", wav_p],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            wav_bytes = open(wav_p, "rb").read()
            from google.genai import types
            resp = self.client.models.generate_content(
                model=self.model,
                contents=[
                    types.Part.from_bytes(data=wav_bytes, mime_type="audio/wav"),
                    "请准确逐字转写这段微信语音消息（中文或中英混合），补充自然标点，只输出转写文本本身，不要添加任何解释或前缀。",
                ],
            )
            text = (resp.text or "").strip()
            self.cache[h] = {
                "text": text,
                "model": self.model,
                "ts": datetime.datetime.now(TZ_SHANGHAI).isoformat(),
            }
            self.stats["transcribed"] += 1
            return text, self.model
        except Exception as e:
            print(f"[WARN] STT failed for {h[:12]}: {e}", file=sys.stderr, flush=True)
            self.stats["failed"] += 1
            return None, f"stt_error:{type(e).__name__}"
        finally:
            for p in (silk_p, pcm_p, wav_p):
                if os.path.exists(p):
                    os.remove(p)


def load_contacts(contact_db: str) -> dict:
    conn = sqlite3.connect(contact_db)
    contacts = {}
    for row in conn.execute("SELECT username, remark, nick_name, alias FROM contact"):
        u, remark, nick, alias = [x or "" for x in row]
        display = remark or nick or alias or u
        contacts[u] = {"username": u, "remark": remark, "nick_name": nick, "alias": alias, "display_name": display}
    conn.close()
    return contacts


def build_hardlink_index(hardlink_db: str, attach_root: str) -> dict:
    """Map md5 -> list of candidate .dat paths (prefer non-_t original over _t thumbnail)."""
    if not hardlink_db or not os.path.exists(hardlink_db):
        return {}
    conn = sqlite3.connect(hardlink_db)
    dir_map = {r[0]: r[1] for r in conn.execute("SELECT rowid, username FROM dir2id")}
    idx = {}
    for md5, ftype, fname, d1, d2 in conn.execute("SELECT md5, type, file_name, dir1, dir2 FROM image_hardlink_info_v4"):
        if not md5 or not fname:
            continue
        p1 = dir_map.get(d1, "")
        p2 = dir_map.get(d2, "")
        if p1 and p2:
            full = os.path.join(attach_root, p1, p2, "Img", fname)
            idx.setdefault(md5.lower(), []).append(full)
    conn.close()
    return idx


def find_image_dat_candidates(md5: str, packed_hashes: list[str], chat_username: str, create_time: int, hardlink_idx: dict, attach_root: str) -> list[tuple[str, str]]:
    """Return ordered list of existing (dat_path, status) preferring original over thumbnail."""
    candidates = []
    seen = set()

    def add(path: str, status: str):
        if path not in seen and os.path.exists(path) and os.path.getsize(path) > 16:
            seen.add(path)
            candidates.append((path, status))

    chat_hash = hashlib.md5(chat_username.encode("utf-8")).hexdigest()
    ym = datetime.datetime.fromtimestamp(create_time, TZ_SHANGHAI).strftime("%Y-%m")
    chat_dir = os.path.join(attach_root, chat_hash)
    ym_dirs = [os.path.join(chat_dir, ym, "Img")]
    if os.path.isdir(chat_dir):
        for sub in sorted(os.listdir(chat_dir), reverse=True):
            d = os.path.join(chat_dir, sub, "Img")
            if d not in ym_dirs and os.path.isdir(d):
                ym_dirs.append(d)

    # 1. Exact filename stem from packed_info_data (most reliable in WeChat 4.1)
    for h in packed_hashes:
        for img_dir in ym_dirs:
            add(os.path.join(img_dir, f"{h}_h.dat"), "original")
            add(os.path.join(img_dir, f"{h}.dat"), "original")
            add(os.path.join(img_dir, f"{h}_t.dat"), "thumbnail")

    # 2. hardlink.db lookup by md5
    if md5 and md5 in hardlink_idx:
        for p in hardlink_idx[md5]:
            stem, ext = os.path.splitext(p)
            if stem.endswith("_t"):
                base = stem[:-2]
                add(base + "_h" + ext, "original")
                add(base + ext, "original")
                add(p, "thumbnail")
            elif stem.endswith("_h"):
                base = stem[:-2]
                add(p, "original")
                add(base + ext, "original")
                add(base + "_t" + ext, "thumbnail")
            else:
                add(stem + "_h" + ext, "original")
                add(p, "original")
                add(stem + "_t" + ext, "thumbnail")

    # 3. Direct md5 fallback
    if md5:
        for img_dir in ym_dirs[:2]:
            add(os.path.join(img_dir, f"{md5}_h.dat"), "original")
            add(os.path.join(img_dir, f"{md5}.dat"), "original")
            add(os.path.join(img_dir, f"{md5}_t.dat"), "thumbnail")

    return candidates

def sanitize_filename(name: str) -> str:
    s = re.sub(r'[\\/:*?"<>|\s]+', "_", name).strip("_")
    return s[:40] or "contact"


def parse_date_ts(date_str: str | None, end_of_day: bool = False) -> int | None:
    if not date_str:
        return None
    dt = datetime.datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=TZ_SHANGHAI)
    if end_of_day:
        dt = dt + datetime.timedelta(days=1) - datetime.timedelta(seconds=1)
    return int(dt.timestamp())


def main():
    parser = argparse.ArgumentParser(description="Export WeChat 4.1.x chat history for specified contacts")
    parser.add_argument("--list-contacts", nargs="?", const="", help="List contacts matching optional keyword")
    parser.add_argument("--contact", help="Target contact remark, nickname, alias, or wxid")
    parser.add_argument("--since", help="Start date YYYY-MM-DD (inclusive)")
    parser.add_argument("--until", help="End date YYYY-MM-DD (inclusive)")
    parser.add_argument("--no-stt", action="store_true", help="Skip Gemini voice STT transcription")
    args = parser.parse_args()

    keys_path = os.environ.get("KEYS_FILE", "/secrets/keys.json")
    out_root = os.environ.get("EXPORT_OUT", "/output")
    keys = json.load(open(keys_path, "r", encoding="utf-8"))
    wxid = keys["wxid"]
    wxid_dir = f"/config/xwechat_files/{wxid}"
    db_root = os.path.join(wxid_dir, "db_storage")
    attach_root = os.path.join(wxid_dir, "msg", "attach")

    work_dir = tempfile.mkdtemp(prefix="woc_export_")
    try:
        contact_db = decrypt_db_snapshot(db_root, "contact/contact.db", keys["db_keys"]["contact/contact.db"], work_dir)
        contacts = load_contacts(contact_db)

        # Decrypt all message_*.db (usually message_0.db, etc.)
        msg_rels = sorted(r for r in keys["db_keys"] if re.match(r"^message/message_\d+\.db$", r))
        msg_dbs = [decrypt_db_snapshot(db_root, r, keys["db_keys"][r], work_dir) for r in msg_rels]

        # Build table -> db mapping
        table_to_db = {}
        table_counts = {}
        for mdb in msg_dbs:
            conn = sqlite3.connect(mdb)
            for (tname,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"):
                cnt = conn.execute(f'SELECT count(*) FROM "{tname}"').fetchone()[0]
                table_to_db.setdefault(tname, []).append(mdb)
                table_counts[tname] = table_counts.get(tname, 0) + cnt
            conn.close()

        # Map username -> Msg_<md5(username)>
        user_msg_counts = {}
        for u in contacts:
            tname = "Msg_" + hashlib.md5(u.encode("utf-8")).hexdigest()
            if tname in table_counts:
                user_msg_counts[u] = table_counts[tname]

        if args.list_contacts is not None:
            kw = args.list_contacts.lower()
            rows = []
            for u, cnt in sorted(user_msg_counts.items(), key=lambda x: -x[1]):
                c = contacts[u]
                if not kw or kw in c["display_name"].lower() or kw in c["nick_name"].lower() or kw in u.lower():
                    rows.append((cnt, c["display_name"], c["nick_name"], u))
            print(f"{'COUNT':>7}  {'DISPLAY_NAME':<24}  {'NICK_NAME':<20}  WXID")
            for cnt, disp, nick, u in rows[:50]:
                print(f"{cnt:>7}  {disp:<24}  {nick:<20}  {u}")
            print(f"\nTotal matched chats with messages: {len(rows)}")
            return

        if not args.contact:
            parser.error("Specify either --list-contacts or --contact <name/wxid>")

        # Resolve target contact
        target_q = args.contact.strip()
        matches = []
        for u, c in contacts.items():
            if u == target_q or c["remark"] == target_q or c["nick_name"] == target_q or c["alias"] == target_q:
                matches.append(u)
        if not matches:
            for u, c in contacts.items():
                if target_q.lower() in c["display_name"].lower() or target_q.lower() in c["nick_name"].lower():
                    if u in user_msg_counts:
                        matches.append(u)
        if not matches:
            print(f"ERROR: No contact found matching '{target_q}'. Run --list-contacts first.", file=sys.stderr)
            sys.exit(1)
        if len(matches) > 1:
            print(f"ERROR: Multiple contacts match '{target_q}'. Please specify exact wxid:", file=sys.stderr)
            for u in matches:
                print(f"  - {contacts[u]['display_name']} ({u}, msgs={user_msg_counts.get(u, 0)})", file=sys.stderr)
            sys.exit(1)

        target_wxid = matches[0]
        target_info = contacts[target_wxid]
        target_table = "Msg_" + hashlib.md5(target_wxid.encode("utf-8")).hexdigest()
        if target_table not in table_to_db:
            print(f"ERROR: No message table found for {target_info['display_name']} ({target_wxid})", file=sys.stderr)
            sys.exit(1)

        since_ts = parse_date_ts(args.since, end_of_day=False)
        until_ts = parse_date_ts(args.until, end_of_day=True)
        is_group = target_wxid.endswith("@chatroom")

        print(f"[*] Exporting: {target_info['display_name']} ({target_wxid}), group={is_group}", flush=True)

        # Decrypt hardlink.db & media_0.db
        hardlink_db = decrypt_db_snapshot(db_root, "hardlink/hardlink.db", keys["db_keys"]["hardlink/hardlink.db"], work_dir)
        hardlink_idx = build_hardlink_index(hardlink_db, attach_root)

        media_rels = sorted(r for r in keys["db_keys"] if re.match(r"^message/media_\d+\.db$", r))
        voice_by_svrid = {}
        voice_by_chat_local = {}
        for mrel in media_rels:
            vdb = decrypt_db_snapshot(db_root, mrel, keys["db_keys"][mrel], work_dir)
            vconn = sqlite3.connect(vdb)
            id_to_chat = {r[0]: r[1] for r in vconn.execute("SELECT rowid, user_name FROM Name2Id")}
            for cid, ctime, lid, svrid, vdata in vconn.execute(
                "SELECT chat_name_id, create_time, local_id, svr_id, voice_data FROM VoiceInfo"
            ):
                if vdata:
                    if svrid:
                        voice_by_svrid[svrid] = bytes(vdata)
                    cname = id_to_chat.get(cid, "")
                    if cname == target_wxid:
                        voice_by_chat_local[lid] = bytes(vdata)
            vconn.close()

        # Prepare output bundle dir
        short_id = hashlib.md5(target_wxid.encode("utf-8")).hexdigest()[:6]
        bundle_name = f"{sanitize_filename(target_info['display_name'])}_{short_id}"
        bundle_dir = os.path.join(out_root, bundle_name)
        images_dir = os.path.join(bundle_dir, "images")
        ensure_dir(out_root)
        ensure_dir(bundle_dir)
        ensure_dir(images_dir)

        stt = GeminiSTT(os.path.join(out_root, ".stt_cache.json"), enabled=not args.no_stt)
        dat_aes = keys.get("dat_aes_key")
        dat_xor = keys.get("dat_xor_key")

        # Collect messages across message_*.db
        raw_msgs = []
        for mdb in table_to_db[target_table]:
            conn = sqlite3.connect(mdb)
            id_to_user = {r[0]: r[1] for r in conn.execute("SELECT rowid, user_name FROM Name2Id")}
            q = (
                f'SELECT local_id, server_id, local_type, sort_seq, real_sender_id, create_time, '
                f'message_content, WCDB_CT_message_content, packed_info_data '
                f'FROM "{target_table}" WHERE 1=1'
            )
            params = []
            if since_ts is not None:
                q += " AND create_time >= ?"
                params.append(since_ts)
            if until_ts is not None:
                q += " AND create_time <= ?"
                params.append(until_ts)
            q += " ORDER BY create_time ASC, sort_seq ASC, local_id ASC"
            for row in conn.execute(q, params):
                raw_msgs.append((row, id_to_user))
            conn.close()

        raw_msgs.sort(key=lambda x: (x[0][5], x[0][3], x[0][0]))

        img_stats = {"original": 0, "thumbnail": 0, "not_downloaded": 0, "decrypt_failed": 0}
        out_records = []
        img_seq = 0

        for (local_id, server_id, local_type, sort_seq, real_sender_id, create_time, msg_content, ct_flag, packed_info), id_to_user in raw_msgs:
            base_type = local_type & 0xFFFFFFFF
            sub_type = local_type >> 32
            text = decompress_field(msg_content, ct_flag)

            sender_wxid = id_to_user.get(real_sender_id, "")
            # In group chats, message_content often starts with "<sender_wxid>:\n"
            if is_group and ":\n" in text and not sender_wxid:
                prefix, rest = text.split(":\n", 1)
                if len(prefix) < 64 and "\n" not in prefix:
                    sender_wxid = prefix
                    text = rest
            elif is_group and sender_wxid and text.startswith(sender_wxid + ":\n"):
                text = text[len(sender_wxid) + 2 :]

            is_self = (sender_wxid == wxid) or (not is_group and sender_wxid == wxid)
            if not sender_wxid and not is_group:
                sender_wxid = target_wxid
            sender_name = contacts.get(sender_wxid, {}).get("display_name", sender_wxid)

            rec = {
                "id": local_id,
                "server_id": server_id,
                "timestamp": datetime.datetime.fromtimestamp(create_time, TZ_SHANGHAI).isoformat(),
                "sender": sender_wxid,
                "sender_name": sender_name,
                "is_self": is_self,
            }

            if base_type == 1:
                rec["type"] = "text"
                rec["content"] = text
            elif base_type == 3:
                rec["type"] = "image"
                rec["content"] = "[图片]"
                info = parse_image_xml(text)
                packed_hashes = [m.decode("ascii") for m in re.findall(rb"[0-9a-f]{32}", bytes(packed_info))] if packed_info else []
                cands = find_image_dat_candidates(info["md5"], packed_hashes, target_wxid, create_time, hardlink_idx, attach_root)
                if not cands:
                    rec["image_status"] = "not_downloaded"
                    img_stats["not_downloaded"] += 1
                else:
                    saved = False
                    saw_wxgf = False
                    for dat_path, status in cands:
                        raw_dat = open(dat_path, "rb").read()
                        dec = decrypt_dat_bytes(raw_dat, dat_aes, dat_xor)
                        if dec:
                            img_seq += 1
                            ext = detect_img_ext(dec)
                            fname = f"{img_seq:04d}_{local_id}{ext}"
                            fpath = os.path.join(images_dir, fname)
                            with open(fpath, "wb") as f:
                                f.write(dec)
                            apply_perms(fpath, is_dir=False)
                            final_status = "thumbnail_wxgf_fallback" if (saw_wxgf and status == "thumbnail") else status
                            rec["image_path"] = f"images/{fname}"
                            rec["image_status"] = final_status
                            img_stats[status] += 1
                            saved = True
                            break
                        else:
                            saw_wxgf = True
                    if not saved:
                        rec["image_status"] = "decrypt_failed"
                        img_stats["decrypt_failed"] += 1
            elif base_type == 34:
                rec["type"] = "voice"
                dur_ms = parse_voice_xml(text)
                rec["duration_ms"] = dur_ms
                silk = voice_by_svrid.get(server_id) or voice_by_chat_local.get(local_id)
                transcript, stt_status = stt.transcribe_silk(silk, work_dir)
                if transcript is not None:
                    rec["transcript"] = transcript
                    rec["content"] = f"[语音] {transcript}"
                    rec["stt_model"] = stt_status
                else:
                    rec["content"] = "[语音]"
                    rec["stt_status"] = stt_status
            elif base_type == 43:
                rec["type"] = "video"
                rec["content"] = "[视频]"
            elif base_type == 47:
                rec.update(parse_emoji(text))
            elif base_type == 49:
                rec.update(parse_appmsg(text, sub_type))
            elif base_type == 10000:
                rec["type"] = "system"
                rec["content"] = re.sub(r"<[^>]+>", "", text).strip()
            else:
                rec["type"] = f"other_{base_type}"
                rec["content"] = text[:500]

            out_records.append(rec)

        stt.save_cache()

        jsonl_path = os.path.join(bundle_dir, "messages.jsonl")
        with open(jsonl_path, "w", encoding="utf-8") as f:
            for r in out_records:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        apply_perms(jsonl_path, is_dir=False)

        manifest = {
            "exported_at": datetime.datetime.now(TZ_SHANGHAI).isoformat(),
            "account_wxid": wxid,
            "contact": target_info,
            "is_group": is_group,
            "filter": {"since": args.since, "until": args.until},
            "message_count": len(out_records),
            "images": img_stats,
            "voice_stt": stt.stats,
            "files": {"messages": "messages.jsonl", "images_dir": "images/"},
        }
        manifest_path = os.path.join(bundle_dir, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)
        apply_perms(manifest_path, is_dir=False)

        print(f"[+] Export complete: {bundle_dir}", flush=True)
        print(f"    messages={len(out_records)}, images={img_stats}, voice_stt={stt.stats}", flush=True)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
