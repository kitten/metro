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

'use strict';

import {createResolutionContext} from './utils';

const Resolver = require('../index');

/**
 * Builds a realistic mock file tree with a deep project structure and
 * node_modules at multiple levels. Mirrors a typical monorepo layout.
 */
function buildFileMap(): {[string]: string} {
  const fileMap: {[string]: string} = {};

  const segments = ['root', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  let currentPath = '';
  for (const segment of segments) {
    currentPath += '/' + segment;
    fileMap[currentPath + '/index.js'] = '';
  }

  for (let i = 2; i <= 8; i++) {
    const dir = '/' + segments.slice(0, i + 1).join('/');
    fileMap[dir + '/source.js'] = '';
  }

  const nmLevels = ['/root', '/root/a/b', '/root/a/b/c/d/e'];
  const packages = [
    'react',
    'react-native',
    'lodash',
    'express',
    'axios',
    'moment',
    'chalk',
    'commander',
    'debug',
    'semver',
  ];

  for (const nmBase of nmLevels) {
    for (const pkg of packages) {
      const pkgDir = nmBase + '/node_modules/' + pkg;
      fileMap[pkgDir + '/package.json'] = JSON.stringify({
        name: pkg,
        main: 'index.js',
      });
      fileMap[pkgDir + '/index.js'] = '';
      fileMap[pkgDir + '/lib/utils.js'] = '';
    }
  }

  const scopedPackages = ['@babel/core', '@babel/parser', '@jest/globals'];
  for (const nmBase of nmLevels) {
    for (const pkg of scopedPackages) {
      const pkgDir = nmBase + '/node_modules/' + pkg;
      fileMap[pkgDir + '/package.json'] = JSON.stringify({
        name: pkg,
        main: 'index.js',
      });
      fileMap[pkgDir + '/index.js'] = '';
    }
  }

  return fileMap;
}

const ITERATIONS = 50_000;
const DEEP_ORIGIN = '/root/a/b/c/d/e/f/g/h/source.js';
const SHALLOW_ORIGIN = '/root/a/b/source.js';

const fileMap = buildFileMap();
const baseContext = createResolutionContext(fileMap);

function bench(
  originModulePath: string,
  moduleName: string,
  expectThrow: boolean = false,
): number {
  // Warm up
  for (let i = 0; i < 1000; i++) {
    try {
      Resolver.resolve(
        {...baseContext, originModulePath},
        moduleName,
        null,
      );
    } catch {}
  }

  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    try {
      Resolver.resolve(
        {...baseContext, originModulePath},
        moduleName,
        null,
      );
    } catch {
      if (!expectThrow) {
        throw new Error('Unexpected resolution failure');
      }
    }
  }
  return performance.now() - start;
}

test('benchmark resolve', () => {
  jest.useRealTimers();

  const results = [
    ['Deep resolve (hit)', bench(DEEP_ORIGIN, 'react')],
    ['Mid-depth resolve (hit)', bench(DEEP_ORIGIN, 'lodash')],
    ['Scoped package (hit)', bench(DEEP_ORIGIN, '@babel/core')],
    ['Resolve miss (throw)', bench(DEEP_ORIGIN, 'nonexistent-pkg', true)],
    ['Shallow resolve (hit)', bench(SHALLOW_ORIGIN, 'react')],
  ];

  const total = results.reduce((sum, [, ms]) => sum + ms, 0);
  const pad = (s: string, n: number) =>
    s + ' '.repeat(Math.max(0, n - s.length));

  const lines = [
    `Resolve benchmark (${ITERATIONS.toLocaleString()} iterations)`,
    '',
    ...results.map(
      ([label, ms]) =>
        `  ${pad(label, 30)} ${ms.toFixed(2).padStart(10)}ms`,
    ),
    `  ${'-'.repeat(42)}`,
    `  ${pad('Total', 30)} ${total.toFixed(2).padStart(10)}ms`,
  ];

  console.log('\n' + lines.join('\n') + '\n');

  expect(total).toBeGreaterThan(0);
});
