import { expect, test } from 'vitest';
import { merge3 } from '../../src/merge/merge3';

test('disjoint edits merge', () =>
  expect(merge3('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n')).toEqual({ clean: true, text: 'A\nb\nC\n' }));
test('identical edits are clean', () =>
  expect(merge3('a\n', 'b\n', 'b\n')).toEqual({ clean: true, text: 'b\n' }));
test('overlapping edits conflict', () =>
  expect(merge3('a\nb\n', 'X\nb\n', 'Y\nb\n')).toEqual({ clean: false }));
test('both append different lines at end conflicts', () =>
  expect(merge3('a\n', 'a\nx\n', 'a\ny\n')).toEqual({ clean: false }));
test('delete on one side, edit elsewhere on the other', () =>
  expect(merge3('a\nb\nc\nd\n', 'a\nc\nd\n', 'a\nb\nc\nD\n')).toEqual({ clean: true, text: 'a\nc\nD\n' }));
test('CRLF local is preserved', () =>
  expect(merge3('a\nb\nc\n', 'A\r\nb\r\nc\r\n', 'a\nb\nC\n')).toEqual({ clean: true, text: 'A\r\nb\r\nC\r\n' }));
test('frontmatter and body edits merge', () =>
  expect(merge3('---\ntags: [a]\n---\nbody\n', '---\ntags: [a, b]\n---\nbody\n', '---\ntags: [a]\n---\nbody 2\n'))
    .toEqual({ clean: true, text: '---\ntags: [a, b]\n---\nbody 2\n' }));
test('empty base with different content conflicts', () =>
  expect(merge3('', 'x\n', 'y\n')).toEqual({ clean: false }));
