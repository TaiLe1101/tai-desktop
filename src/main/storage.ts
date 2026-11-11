import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export async function ensureAudioDirectory(directory: string) {
  if (!isAbsolute(directory)) throw new Error('Cần chọn đường dẫn thư mục tuyệt đối.');
  await mkdir(directory, { recursive: true });
  // Check actual write access, including read-only volumes and network shares.
  const probe = join(directory, `.tai-write-check-${randomUUID()}`);
  const file = await open(probe, 'wx');
  try { await file.writeFile('TAI'); }
  finally { await file.close(); await unlink(probe); }
}
