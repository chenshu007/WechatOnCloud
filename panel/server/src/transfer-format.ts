// GNU find's NUL-delimited triples preserve tabs/newlines in valid filenames.
export function parseTransferFiles(raw: string): { name: string; size: number; mtime: number }[] {
  const fields = raw.split('\0');
  const files: { name: string; size: number; mtime: number }[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [name, size, time] = fields.slice(i, i + 3);
    if (!name) continue;
    const mtime = Number(time);
    files.push({ name, size: Number(size) || 0, mtime: Number.isFinite(mtime) ? mtime : 0 });
  }
  return files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function entry(name: string, content: Buffer, mtime: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(content.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  const sum = h.reduce((a, b) => a + b, 0);
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

// PAX path avoids truncating long UTF-8 basenames at the 100-byte USTAR limit.
export function tarEntry(name: string, content: Buffer, mtime = Date.now() / 1000): Buffer {
  if (Buffer.byteLength(name, 'utf8') <= 100) return entry(name, content, mtime);
  const value = `path=${name}\n`;
  let length = Buffer.byteLength(value) + 2;
  while (length !== Buffer.byteLength(value) + String(length).length + 1) {
    length = Buffer.byteLength(value) + String(length).length + 1;
  }
  return Buffer.concat([
    entry('PaxHeaders/woc', Buffer.from(`${length} ${value}`), mtime, 'x'),
    entry('woc-file', content, mtime),
  ]);
}
