import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Extensions we treat as binary without sniffing the file. Avoids reading
 * large assets just to confirm what's obvious from the name. Lower-case.
 *
 * Mirrors the heuristic VS Code's git extension uses internally — there is
 * no public API to delegate to it, so we maintain our own list. Users can
 * extend it via the `diversion.binaryExtensions` setting.
 */
const BINARY_EXTENSIONS = new Set([
  // executables / libraries
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.bin', '.elf',
  // archives / packages
  '.zip', '.7z', '.gz', '.tar', '.tgz', '.bz2', '.rar', '.xz', '.lz4', '.zst',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico',
  '.psd', '.tga', '.exr', '.hdr', '.svg.bin',
  // audio / video
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.mov', '.mkv',
  '.avi', '.webm', '.wmv',
  // 3D / engine assets
  '.fbx', '.obj.bin', '.dae', '.gltf', '.glb', '.usd', '.usda', '.usdc', '.abc',
  '.uasset', '.umap', '.unity', '.unitypackage', '.prefab.bin', '.asset.bin',
  '.mesh', '.anim.bin',
  // documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // fonts / databases
  '.ttf', '.otf', '.woff', '.woff2', '.db', '.sqlite', '.sqlite3', '.mdb',
  // misc
  '.pyc', '.class', '.jar', '.war', '.deb', '.rpm', '.iso', '.dmg',
]);

const SAMPLE_BYTES = 8192;

/**
 * Probe a file to decide if it's binary. Cheap path: extension lookup.
 * Fallback: read the first 8KB and check for null bytes (the standard
 * heuristic git/dv use). Returns true if we should skip text-based diffing.
 */
export async function looksBinary(fsPath: string): Promise<boolean> {
  const ext = path.extname(fsPath).toLowerCase();
  if (ext && BINARY_EXTENSIONS.has(ext)) return true;
  if (ext && userExtensions().has(ext)) return true;

  try {
    const handle = await fs.open(fsPath, 'r');
    try {
      const buf = Buffer.alloc(SAMPLE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SAMPLE_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    // If we can't read it (deleted, permission), don't claim binary —
    // higher layers will fall through to "unable to open" semantics.
    return false;
  }
}

function userExtensions(): Set<string> {
  const list = vscode.workspace.getConfiguration('diversion').get<string[]>('binaryExtensions', []);
  const out = new Set<string>();
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    out.add(e.startsWith('.') ? e : `.${e}`);
  }
  return out;
}
