export type Hasher = (data: ArrayBuffer) => Promise<string>;

const BLOCK_SIZE = 4 * 1024 * 1024;

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export const contentHash: Hasher = async (data: ArrayBuffer): Promise<string> => {
  const numBlocks = Math.ceil(data.byteLength / BLOCK_SIZE);
  const concatDigests = new Uint8Array(numBlocks * 32);

  for (let i = 0; i < numBlocks; i++) {
    const start = i * BLOCK_SIZE;
    const end = Math.min(start + BLOCK_SIZE, data.byteLength);
    const block = data.slice(start, end);
    const blockDigest = await crypto.subtle.digest('SHA-256', block);
    concatDigests.set(new Uint8Array(blockDigest), i * 32);
  }

  const finalDigest = await crypto.subtle.digest('SHA-256', concatDigests);
  return toHex(finalDigest);
};
