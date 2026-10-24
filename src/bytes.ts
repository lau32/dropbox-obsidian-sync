const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export function encodeText(s: string): ArrayBuffer {
  const bytes = encoder.encode(s);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function decodeText(b: ArrayBuffer): string {
  return decoder.decode(b);
}
