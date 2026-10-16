import { createHash } from 'node:crypto';
import { contentHash } from '../../src/hash/contentHash';
import { encodeText, decodeText } from '../../src/bytes';

const sha = (b: Buffer) => createHash('sha256').update(b).digest();
const oracle = (buf: Buffer) => {
  const blocks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 4 * 1024 * 1024) blocks.push(sha(buf.subarray(i, i + 4 * 1024 * 1024)));
  return sha(Buffer.concat(blocks)).toString('hex');
};
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer;

test.each([0, 3, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024])('matches oracle for %i bytes', async (n) => {
  const buf = Buffer.alloc(n, 7);
  expect(await contentHash(ab(buf))).toBe(oracle(buf));
});
test('empty file hash', async () => {
  expect(await contentHash(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('text roundtrip', () => expect(decodeText(encodeText('héllo 😀'))).toBe('héllo 😀'));
