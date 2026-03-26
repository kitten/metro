/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @oncall react_native
 */

import type {FileMetadata} from '../../../flow-types';

jest.mock('graceful-fs', () => ({
  lstatSync: jest.fn(),
  readlinkSync: jest.fn(),
  readdirSync: jest.fn(),
}));

// $FlowFixMe[unclear-type]
const fs: any = require('graceful-fs');
const createFallbackFilesystem =
  require('../fallback').default;

describe('createFallbackFilesystem', () => {
  const defaultOpts = {
    extensions: ['js', 'ts', 'json'],
    ignore: () => false,
    includeSymlinks: true,
  };

  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('lookup', () => {
    test('returns null for ignored paths', () => {
      const fallback = createFallbackFilesystem({
        ...defaultOpts,
        ignore: (p: string) => p.includes('__fixtures__'),
      });
      const result = fallback.lookup('/project/src/__fixtures__/test.js');
      expect(result).toBeNull();
      expect(fs.lstatSync).not.toHaveBeenCalled();
    });

    test('returns null when lstatSync throws', () => {
      fs.lstatSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const fallback = createFallbackFilesystem(defaultOpts);
      expect(fallback.lookup('/project/nonexistent')).toBeNull();
    });

    test('returns "d" for directories', () => {
      fs.lstatSync.mockReturnValue(({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
      }: $FlowFixMe));
      const fallback = createFallbackFilesystem(defaultOpts);
      expect(fallback.lookup('/project/node_modules')).toBe('d');
    });

    test('returns FileMetadata for files with matching extension', () => {
      fs.lstatSync.mockReturnValue(({
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
        mtime: {getTime: () => 1000},
        size: 42,
      }: $FlowFixMe));
      const fallback = createFallbackFilesystem(defaultOpts);
      const result: FileMetadata | 'd' | null =
        fallback.lookup('/project/foo.js');
      expect(result).toEqual([1000, 42, 0, null, 0, null]);
    });

    test('returns null for files with non-matching extension', () => {
      fs.lstatSync.mockReturnValue(({
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
        mtime: {getTime: () => 1000},
        size: 42,
      }: $FlowFixMe));
      const fallback = createFallbackFilesystem(defaultOpts);
      expect(fallback.lookup('/project/foo.py')).toBeNull();
    });

    test('returns FileMetadata for symlinks when includeSymlinks is true', () => {
      fs.lstatSync.mockReturnValue(({
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isFile: () => false,
        mtime: {getTime: () => 1000},
        size: 10,
      }: $FlowFixMe));
      fs.readlinkSync.mockReturnValue('./target.js');
      const fallback = createFallbackFilesystem(defaultOpts);
      const result: FileMetadata | 'd' | null =
        fallback.lookup('/project/link.js');
      expect(result).toEqual([1000, 10, 0, null, './target.js', null]);
    });

    test('returns null for symlinks when includeSymlinks is false', () => {
      fs.lstatSync.mockReturnValue(({
        isDirectory: () => false,
        isSymbolicLink: () => true,
        isFile: () => false,
      }: $FlowFixMe));
      const fallback = createFallbackFilesystem({
        ...defaultOpts,
        includeSymlinks: false,
      });
      expect(fallback.lookup('/project/link.js')).toBeNull();
    });
  });

  describe('readdir', () => {
    test('returns null when readdirSync throws', () => {
      fs.readdirSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });
      const fallback = createFallbackFilesystem(defaultOpts);
      expect(fallback.readdir('/project/nonexistent')).toBeNull();
    });

    test('filters children by ignore pattern', () => {
      fs.readdirSync.mockReturnValue(([
        {name: 'good.js', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true},
        {name: '__fixtures__', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false},
      ]: $FlowFixMe));
      const fallback = createFallbackFilesystem({
        ...defaultOpts,
        ignore: (p: string) => p.includes('__fixtures__'),
      });
      const result = fallback.readdir('/project/src');
      expect(result).not.toBeNull();
      if (result != null) {
        expect(result.has('good.js')).toBe(true);
        expect(result.has('__fixtures__')).toBe(false);
      }
    });

    test('filters files by extension', () => {
      fs.readdirSync.mockReturnValue(([
        {name: 'app.js', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true},
        {name: 'styles.css', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true},
        {name: 'data.json', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true},
      ]: $FlowFixMe));
      const fallback = createFallbackFilesystem(defaultOpts);
      const result = fallback.readdir('/project/src');
      expect(result).not.toBeNull();
      if (result != null) {
        expect(result.has('app.js')).toBe(true);
        expect(result.has('styles.css')).toBe(false);
        expect(result.has('data.json')).toBe(true);
      }
    });

    test('skips symlinks when includeSymlinks is false', () => {
      fs.readdirSync.mockReturnValue(([
        {name: 'real.js', isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true},
        {name: 'link.js', isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false},
      ]: $FlowFixMe));
      const fallback = createFallbackFilesystem({
        ...defaultOpts,
        includeSymlinks: false,
      });
      const result = fallback.readdir('/project/src');
      expect(result).not.toBeNull();
      if (result != null) {
        expect(result.has('real.js')).toBe(true);
        expect(result.has('link.js')).toBe(false);
      }
    });

    test('includes symlinks when includeSymlinks is true', () => {
      fs.readdirSync.mockReturnValue(([
        {name: 'link.js', isDirectory: () => false, isSymbolicLink: () => true, isFile: () => false},
      ]: $FlowFixMe));
      fs.readlinkSync.mockReturnValue('./target.js');
      const fallback = createFallbackFilesystem(defaultOpts);
      const result = fallback.readdir('/project/src');
      expect(result).not.toBeNull();
      if (result != null) {
        expect(result.has('link.js')).toBe(true);
        const entry = result.get('link.js');
        expect(entry).toEqual([0, 0, 0, null, './target.js', null]);
      }
    });

    test('includes directories as "d"', () => {
      fs.readdirSync.mockReturnValue(([
        {name: 'subdir', isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false},
      ]: $FlowFixMe));
      const fallback = createFallbackFilesystem(defaultOpts);
      const result = fallback.readdir('/project/src');
      expect(result).not.toBeNull();
      if (result != null) {
        expect(result.get('subdir')).toBe('d');
      }
    });
  });
});
