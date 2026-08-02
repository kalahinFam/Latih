/**
 * Maps a cue phrase to its audio filename.
 *
 * The name is derived from the text, so editing a phrase points at a file that
 * does not exist rather than quietly playing the old recording. A stale clip
 * would be the worst kind of bug here: the app would confidently say the wrong
 * correction, and nothing in the code would look wrong.
 *
 * Shared by the build-time generator and the runtime player, so the two cannot
 * disagree about what a file is called.
 */

/**
 * FNV-1a, 32-bit. Not a security hash — it just needs to be stable, short, and
 * identical in Node and the browser without pulling in a crypto dependency for
 * seven short strings.
 */
export function cueHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Readable prefix so the directory can be skimmed, hash for correctness. */
export function cueFileName(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${slug}-${cueHash(text)}.mp3`;
}

export const CUE_DIR = '/cues';

export function cueUrl(text: string): string {
  return `${CUE_DIR}/${cueFileName(text)}`;
}
