/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow strict
 * @oncall react_native
 */

import type {
  RootPathUtils as RootPathUtilsT,
  pathsToPattern as pathsToPatternT,
} from '../RootPathUtils';

let mockPathModule;
jest.mock('path', () => mockPathModule);

describe.each([['win32'], ['posix']])('RootPathUtils on %s', platform => {
  // Convenience function to write paths with posix separators but convert them
  // to system separators
  const p: string => string = filePath =>
    platform === 'win32'
      ? filePath.replace(/\//g, '\\').replace(/^\\/, 'C:\\')
      : filePath;

  let RootPathUtils: Class<RootPathUtilsT>;
  let pathUtils: RootPathUtilsT;
  let pathRelative: JestMockFn<[string, string], string>;
  let sep: string;

  beforeEach(() => {
    jest.resetModules();
    mockPathModule = jest.requireActual<{}>('path')[platform];
    sep = mockPathModule.sep;
    pathRelative = jest.spyOn(mockPathModule, 'relative');
    RootPathUtils = require('../RootPathUtils').RootPathUtils;
  });

  test.each([
    p('/project/root/baz/foobar'),
    p('/project/root/../root2/foobar'),
    p('/project/root/../../project2/foo'),
    p('/project/root/../../project/foo'),
    p('/project/root/../../project/foo/'),
    p('/project/root/../../project/root'),
    p('/project/root/../../project/root/'),
    p('/project/root/../../project/root/foo.js'),
    p('/project/bar'),
    p('/project/bar/'),
    p('/project/../outside/bar'),
    p('/project/baz/foobar'),
    p('/project/rootfoo/baz'),
    p('/project'),
    p('/project/'),
    p('/'),
    p('/outside'),
    p('/outside/'),
  ])(`absoluteToNormal('%s') is correct and optimised`, absolutePath => {
    const rootDir = p('/project/root');
    pathUtils = new RootPathUtils(rootDir);
    let expected = mockPathModule.relative(rootDir, absolutePath);
    // Unlike path.relative, we expect to preserve trailing separators.
    if (absolutePath.endsWith(sep) && expected !== '') {
      expected += sep;
    }
    pathRelative.mockClear();
    expect(pathUtils.absoluteToNormal(absolutePath)).toEqual(expected);
    expect(pathRelative).not.toHaveBeenCalled();
  });

  describe.each([p('/project/root'), p('/')])('root: %s', rootDir => {
    beforeEach(() => {
      pathRelative.mockClear();
      pathUtils = new RootPathUtils(rootDir);
    });

    test.each([
      p('/project/root/../root2/../root3/foo'),
      p('/project/root/./baz/foo/bar'),
      p('/project/root/a./../foo'),
      p('/project/root/../a./foo'),
      p('/project/root/.././foo'),
      p('/project/root/.././foo/'),
    ])(`absoluteToNormal('%s') falls back to path.relative`, absolutePath => {
      let expected = mockPathModule.relative(rootDir, absolutePath);
      // Unlike path.relative, we expect to preserve trailing separators.
      if (absolutePath.endsWith(sep) && !expected.endsWith(sep)) {
        expected += sep;
      }
      pathRelative.mockClear();
      expect(pathUtils.absoluteToNormal(absolutePath)).toEqual(expected);
      expect(pathRelative).toHaveBeenCalled();
    });

    test.each([
      p('..'),
      p('../..'),
      p('../../'),
      p('normal/path'),
      p('normal/path/'),
      p('../normal/path'),
      p('../normal/path/'),
      p('../../normal/path'),
      p('../../../normal/path'),
    ])(`normalToAbsolute('%s') matches path.resolve`, normalPath => {
      let expected = mockPathModule.resolve(rootDir, normalPath);
      // Unlike path.resolve, we expect to preserve trailing separators.
      if (normalPath.endsWith(sep) && !expected.endsWith(sep)) {
        expected += sep;
      }
      expect(pathUtils.normalToAbsolute(normalPath)).toEqual(expected);
    });

    test.each([
      p('..'),
      p('../root'),
      p('../root/path'),
      p('../project'),
      p('../project/'),
      p('../../project/root'),
      p('../../project/root/'),
      p('../../../normal/path'),
      p('../../../normal/path/'),
      p('../../..'),
    ])(
      `relativeToNormal('%s') matches path.resolve + path.relative`,
      relativePath => {
        let expected = mockPathModule.relative(
          rootDir,
          mockPathModule.resolve(rootDir, relativePath),
        );
        // Unlike native path.resolve + path.relative, we expect to preserve
        // trailing separators. (Consistent with path.normalize.)
        if (
          relativePath.endsWith(sep) &&
          !expected.endsWith(sep) &&
          expected !== ''
        ) {
          expected += sep;
        }
        expect(pathUtils.relativeToNormal(relativePath)).toEqual(expected);
      },
    );
  });

  test.each([
    ['foo', null],
    ['', 0],
    ['..', 1],
    [p('../..'), 2],
    [p('../../..'), 3],
    [p('../../../foo'), null],
    [p('../../../..foo'), null],
  ])('getAncestorOfRootIdx (%s => %s)', (input, expected) => {
    expect(pathUtils.getAncestorOfRootIdx(input)).toEqual(expected);
  });
});

describe.each([['win32'], ['posix']])('pathsToPattern on %s', platform => {
  let pathsToPattern: typeof pathsToPatternT;
  let RootPathUtils: Class<RootPathUtilsT>;

  // Convenience function to write paths with posix separators but convert them
  // to system separators (with drive letter on win32)
  const p: string => string = filePath =>
    platform === 'win32'
      ? filePath.replace(/\//g, '\\').replace(/^\\/, 'C:\\')
      : filePath;

  const rootDir = p('/project/root');

  beforeEach(() => {
    jest.resetModules();
    mockPathModule = jest.requireActual<{}>('path')[platform];
    ({RootPathUtils, pathsToPattern} = require('../RootPathUtils'));
  });

  test('empty array returns a pattern that never matches', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([], pu);
    expect(pattern.test('')).toBe(false);
    expect(pattern.test('anything')).toBe(false);
    expect(pattern.test('packages')).toBe(false);
  });

  test('single path matches children', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/packages/foo')], pu);
    // Resulting normal paths are root-relative: packages/foo
    expect(pattern.test(p('packages/foo/bar'))).toBe(true);
    expect(pattern.test(p('packages/foo/bar/baz'))).toBe(true);
  });

  test('single path does not match the path itself (no trailing sep)', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/packages/foo')], pu);
    expect(pattern.test(p('packages/foo'))).toBe(false);
  });

  test('single path does not match siblings or unrelated paths', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/packages/foo')], pu);
    expect(pattern.test(p('packages/foobar/baz'))).toBe(false);
    expect(pattern.test(p('packages/bar/baz'))).toBe(false);
    expect(pattern.test(p('other/path'))).toBe(false);
  });

  test('single path does not match ancestors', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/packages/foo')], pu);
    expect(pattern.test(p('packages/'))).toBe(false);
    expect(pattern.test('')).toBe(false);
  });

  test('multiple paths match children of any root', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern(
      [p('/project/root/packages/foo'), p('/project/root/packages/bar')],
      pu,
    );
    expect(pattern.test(p('packages/foo/file.js'))).toBe(true);
    expect(pattern.test(p('packages/bar/file.js'))).toBe(true);
    expect(pattern.test(p('packages/baz/file.js'))).toBe(false);
  });

  test('paths with regex-special characters are escaped', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/packages/foo.bar')], pu);
    expect(pattern.test(p('packages/foo.bar/baz'))).toBe(true);
    // The dot should be literal, not match any character
    expect(pattern.test(p('packages/fooXbar/baz'))).toBe(false);
  });

  test('path at root level (single segment)', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root/src')], pu);
    expect(pattern.test(p('src/index.js'))).toBe(true);
    expect(pattern.test(p('src/nested/file.js'))).toBe(true);
    expect(pattern.test(p('srcOther/file.js'))).toBe(false);
  });

  test('path equal to rootDir matches all non-escaped paths', () => {
    const pu = new RootPathUtils(rootDir);
    const pattern = pathsToPattern([p('/project/root')], pu);
    expect(pattern).not.toBeNull();
    // Paths inside rootDir match
    expect(pattern.test(p('src/index.js'))).toBe(true);
    expect(pattern.test(p('node_modules/foo/bar.js'))).toBe(true);
    expect(pattern.test(p('packages/foo/bar'))).toBe(true);
    // Paths escaping rootDir via '..' do not match
    expect(pattern.test(p('../sibling/foo'))).toBe(false);
    expect(pattern.test('..')).toBe(false);
    // A segment that merely starts with '..' is still inside rootDir
    expect(pattern.test(p('..foo/bar'))).toBe(true);
  });
});
