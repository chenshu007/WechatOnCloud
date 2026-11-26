# WOC Chat Exporter (Zero-Invasion Sidecar)

A standalone, read-only sidecar toolkit for exporting specified contacts' chat history from a running **WechatOnCloud (WOC)** Linux ARM64 WeChat `4.1.x` instance into self-contained, AI-Agent-ready bundles (`messages.jsonl` + decrypted `images/` + `manifest.json`), with optional Gemini Flash voice-to-text transcription.

> [!NOTE]
> Intended strictly for personal local backup and analysis of your own WeChat account data. Do **not** upload extracted keys or plaintext exports to public or untrusted cloud storage.

## Architecture

1. **Zero modification to WOC containers**: Never edits `woc-panel` or `woc-wx-*` containers, and always mounts the WOC data volume strictly read-only (`:ro`).
2. **Phase 1 — One-time ephemeral key extraction** (`extract_keys.sh` + `extract_dat_key.sh`):
   - Runs a temporary container with `--pid=container:woc-wx-<ID>` and `--cap-add=SYS_PTRACE` to extract & cryptographically verify:
     - All SQLCipher 4 database keys (`contact.db`, `message_*.db`, `media_*.db`, `hardlink.db`, `session.db`, etc.)
     - V2 `.dat` image XOR key + XOR-unmasked AES-128-ECB key (WeChat Linux ARM64 `4.1.1.8`)
   - Persists keys to `secrets/keys.json` (`chmod 600`) and immediately removes the temporary container.
3. **Phase 2 — Unprivileged manual export** (`export.sh`):
   - Runs **without** `SYS_PTRACE` and **without** PID namespace sharing; copies `.db` + `-wal` + `-shm` snapshots to an ephemeral `/tmp` directory inside the container, decrypts offline, and exports only the specified contact(s).
   - **Images**: Locates `.dat` via `packed_info_data` + `hardlink.db` fallback, prefers original over thumbnail, and automatically falls back to standard JPEG thumbnail if the original is WeChat's proprietary `wxgf` format (`image_status: "thumbnail_wxgf_fallback"`).
   - **Voice STT**: Decodes SILK v3 blobs from `media_*.db` via `pilk` + `ffmpeg`, transcribes with Gemini Flash (`gemini-2.5-flash`), and caches results locally by audio SHA256 (`.stt_cache.json`).
   - **Permissions**: Outputs directories as `750` and files as `640` (owner `EXPORT_UID:EXPORT_GID`, default `1000:10`), making it easy to mount read-only (`:ro`) into local NAS AI Agent containers while keeping plaintext exports outside cloud backup paths.

## Quick Start

```bash
cd tools/chat-exporter

# 1. Build the local image
docker build -t woc-chat-exporter:local .

# 2. Configure secrets/.env (chmod 600)
cp secrets/.env.example secrets/.env
chmod 600 secrets/.env
# Edit secrets/.env and set WOC_INSTANCE_ID, EXPORT_OUT_DIR, and optional GEMINI_API_KEY

# 3. One-time key extraction (DB keys + V2 .dat image key)
./extract_keys.sh
./extract_dat_key.sh

# 4. List contacts with message counts
./export.sh --list-contacts "keyword"

# 5. Export a specified contact (with optional date range)
./export.sh --contact "Remark or Nickname or wxid" --since 2026-01-01
```

If your user requires `sudo docker`, prefix commands with `DOCKER_CMD="sudo -n docker"`.

## Output Bundle Structure

```text
<EXPORT_OUT_DIR>/<ContactName>_<short_id>/
├── messages.jsonl    # Chronological JSONL (relative image paths, quotes, metadata, voice transcripts)
├── images/           # Decrypted standard JPG/PNG/WEBP images
└── manifest.json     # Export summary (counts, image statuses, STT cache stats)
```

## Notes on WeChat Version Compatibility

- `find_dat_key.py` unmasks the 32-byte XOR-obfuscated V2 `.dat` AES key using the static mask offsets (`0x1006400`, `0x1004190`) verified on **Linux ARM64 WeChat `4.1.1.8`**. If you upgrade WeChat inside WOC to a newer build, re-verify those offsets via static disassembly of `getV2ImageAesKey`.
