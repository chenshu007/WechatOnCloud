export const MAX_PASTE_IMAGE_BYTES = 64 * 1024 * 1024;
export class PasteError extends Error {
  constructor(message: string, public statusCode = 400, public outcome: 'not-started' | 'unknown' = 'not-started') { super(message); }
}
export function validatePasteImage(mime: unknown, content: unknown): asserts content is Buffer {
  if (typeof mime !== 'string' || !Buffer.isBuffer(content) || !content.length) throw new PasteError('空图片或格式错误');
  if (content.length > MAX_PASTE_IMAGE_BYTES) throw new PasteError('图片超过 64 MiB', 413);
  const b = content;
  const valid = mime === 'image/png' ? b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && b.toString('ascii',12,16)==='IHDR'
    : mime === 'image/jpeg' ? b.length >= 4 && b[0]===255 && b[1]===216 && b[2]===255
    : mime === 'image/gif' ? b.length >= 10 && /GIF8[79]a/.test(b.toString('ascii',0,6))
    : mime === 'image/webp' ? b.length >= 16 && b.toString('ascii',0,4)==='RIFF' && b.toString('ascii',8,12)==='WEBP'
    : mime === 'image/bmp' ? b.length >= 26 && b.toString('ascii',0,2)==='BM' : false;
  if (!valid) throw new PasteError('图片类型不支持或内容与 MIME 不符');
}
const active = new Set<string>();
export async function withInstanceInput<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (active.has(id)) throw new PasteError('该实例正在处理输入，请稍后再试', 409);
  active.add(id);
  try { return await operation(); } finally { active.delete(id); }
}
// Fixed program; MIME/path are positional arguments, never shell source.
// Compare the selection against this request before dispatching Ctrl+V. No Return.
export const IMAGE_PASTE_SCRIPT = `set -eu
display="\${DISPLAY:-}"
if [ -z "$display" ]; then for x in /tmp/.X11-unix/X*; do [ -e "$x" ] || continue; display=":\${x##*X}"; break; done; fi
export DISPLAY="\${display:-:1}"
command -v xclip >/dev/null
command -v xdotool >/dev/null
command -v timeout >/dev/null
trap 'rm -f -- "$2"; rmdir -- "\${2%/*}" 2>/dev/null || true' EXIT
timeout 5 xclip -selection clipboard -t "$1" -i "$2" >/dev/null 2>&1
ready=0
for i in {1..20}; do
  if (set -o pipefail; timeout 2 xclip -selection clipboard -t "$1" -o 2>/dev/null | cmp -s -- "$2" -); then ready=1; break; fi
  sleep 0.05
done
[ "$ready" = 1 ] || exit 1
rm -f -- "$2"
timeout 5 xdotool key --clearmodifiers ctrl+v
`;
