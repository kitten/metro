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

import type {FileData, FileMetadata} from '../../flow-types';

import H from '../../constants';

let mockPathModule;
jest.mock('path', () => mockPathModule);

// Tunables for the generated fixture.
const NUM_SOURCE_FILES = 500;
const NUM_PACKAGES = 200;
const FILES_PER_PACKAGE = 8;
const ITERATIONS = 20_000;

/**
 * Detect whether TreeFS expects pre-resolved (normal) symlink targets, or
 * literal (relative/absolute) targets resolved at runtime. The branch under
 * test stores targets pre-resolved; main resolves them via path.resolve at
 * lookup time.
 */
function detectSymlinkMode(TreeFS: $FlowFixMe): boolean {
  // Build a minimal tree: a file and a symlink with a relative literal target.
  const probe = new TreeFS({
    rootDir: '/probe',
    files: new Map([
      ['dir/target.js', [1, 1, 0, null, 0, null]],
      // Literal relative target — what `readlink` returns for the symlink.
      ['dir/link.js', [0, 0, 0, null, 'target.js', null]],
    ]),
    processFile: () => null,
  });
  // If TreeFS resolves the literal target at runtime (main), looking up
  // through the symlink succeeds. If it expects a pre-resolved normal path,
  // 'target.js' is treated as a root-relative path and won't resolve to
  // 'dir/target.js'.
  const result = probe.lookup('/probe/dir/link.js');
  return !result.exists;
}

/**
 * Generate a pnpm-like isolated-install layout.
 *
 * Physical files under .pnpm:
 *   node_modules/.pnpm/<name>@1.0.0/node_modules/<name>/index.js
 *   node_modules/.pnpm/<name>@1.0.0/node_modules/<name>/lib/helper0.js
 *   ...
 *
 * Hoisted symlinks:
 *   node_modules/<name> -> .pnpm/<name>@1.0.0/node_modules/<name>
 *
 * Peer-dep symlinks (within .pnpm, every 3rd package):
 *   node_modules/.pnpm/<name>@1.0.0/node_modules/<peer> ->
 *     ../../<peer>@1.0.0/node_modules/<peer>
 */
function generatePnpmLayout(preResolved: boolean): {
  files: FileData,
  sourceFilePaths: Array<string>,
  hoistedSymlinkPaths: Array<string>,
  deepPackageFilePaths: Array<string>,
} {
  const files: FileData = new Map();
  const sourceFilePaths: Array<string> = [];
  const hoistedSymlinkPaths: Array<string> = [];
  const deepPackageFilePaths: Array<string> = [];

  // Source files at project root
  for (let i = 0; i < NUM_SOURCE_FILES; i++) {
    const dir = `src/features/feature${Math.floor(i / 10)}`;
    const filePath = `${dir}/file${i}.js`;
    files.set(filePath, [1000000 + i, 100 + i, 0, null, 0, null]);
    sourceFilePaths.push(filePath);
  }

  // A few top-level config/entry files
  for (const name of [
    'index.js',
    'app.js',
    'metro.config.js',
    'package.json',
  ]) {
    files.set(name, [1000000, 50, 0, null, 0, null]);
    sourceFilePaths.push(name);
  }

  const packageNames: Array<string> = [];
  for (let i = 0; i < NUM_PACKAGES; i++) {
    packageNames.push(`pkg-${String(i).padStart(3, '0')}`);
  }

  // Physical files inside .pnpm store
  for (const pkgName of packageNames) {
    const storeBase = `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;

    const pkgJsonPath = `${storeBase}/package.json`;
    files.set(pkgJsonPath, [2000000, 200, 0, null, 0, null]);
    deepPackageFilePaths.push(pkgJsonPath);

    const indexPath = `${storeBase}/index.js`;
    files.set(indexPath, [2000000, 150, 0, null, 0, null]);
    deepPackageFilePaths.push(indexPath);

    for (let f = 0; f < FILES_PER_PACKAGE - 2; f++) {
      const libPath = `${storeBase}/lib/helper${f}.js`;
      files.set(libPath, [2000000, 80 + f, 0, null, 0, null]);
      deepPackageFilePaths.push(libPath);
    }
  }

  // Hoisted symlinks: node_modules/<name> -> .pnpm store location.
  // preResolved: target is already a root-relative normal path.
  // !preResolved: target is a literal relative path (like readlink output).
  for (const pkgName of packageNames) {
    const symlinkPath = `node_modules/${pkgName}`;
    const target = preResolved
      ? `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`
      : `.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;
    files.set(symlinkPath, [0, 0, 0, null, target, null]);
    hoistedSymlinkPaths.push(symlinkPath);
  }

  // Peer-dep symlinks within .pnpm (every 3rd package)
  for (let i = 0; i < packageNames.length; i++) {
    if (i % 3 !== 0) {
      continue;
    }
    const pkgName = packageNames[i];
    const peerName = packageNames[(i + 1) % packageNames.length];
    const peerSymlinkPath = `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${peerName}`;
    const peerTarget = preResolved
      ? `node_modules/.pnpm/${peerName}@1.0.0/node_modules/${peerName}`
      : `../../${peerName}@1.0.0/node_modules/${peerName}`;
    files.set(peerSymlinkPath, [0, 0, 0, null, peerTarget, null]);
  }

  return {files, sourceFilePaths, hoistedSymlinkPaths, deepPackageFilePaths};
}

function bench(fn: () => void, iterations: number): number {
  // Warm up
  for (let i = 0; i < Math.min(1000, Math.floor(iterations / 10)); i++) {
    fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return performance.now() - start;
}

test('benchmark TreeFS with pnpm-like symlink layout', () => {
  jest.useRealTimers();
  jest.resetModules();
  mockPathModule = jest.requireActual<{}>('path').posix;

  const TreeFS = require('../TreeFS').default;

  const preResolved = detectSymlinkMode(TreeFS);
  const layout = generatePnpmLayout(preResolved);

  const newTfs = () =>
    new TreeFS({
      rootDir: '/project',
      files: layout.files,
      processFile: () => {
        throw new Error('Not implemented');
      },
    });

  const tfs = newTfs();

  // Sanity: verify symlinks actually resolve through the tree.
  const sanity = tfs.lookup(
    '/project/node_modules/pkg-000/index.js',
  );
  if (!sanity.exists) {
    throw new Error(
      'Sanity check failed: symlink lookup did not resolve. ' +
        `preResolved=${String(preResolved)}`,
    );
  }

  // Pre-compute lookup paths
  const hoistedLookupPaths = layout.hoistedSymlinkPaths.map(
    link => '/project/' + link + '/index.js',
  );
  const sourceLookupPaths = layout.sourceFilePaths.map(f => '/project/' + f);
  const deepLookupPaths = layout.deepPackageFilePaths.map(
    f => '/project/' + f,
  );
  const hierarchicalStartPaths = layout.hoistedSymlinkPaths.map(
    link => '/project/' + link + '/lib/helper0.js',
  );
  const missingPaths = layout.hoistedSymlinkPaths.map(
    link => '/project/' + link + '/nonexistent.js',
  );

  // --- getDifference: re-crawled data identical to what's in the tree ---
  const recrawled: FileData = new Map(layout.files);

  // --- getDifference: 1% of files have changed mtimes ---
  const recrawledFewChanges: FileData = new Map(layout.files);
  let modified = 0;
  for (const [filePath, metadata] of recrawledFewChanges) {
    if (modified >= Math.ceil(layout.files.size * 0.01)) break;
    if (metadata[H.SYMLINK] === 0) {
      const updated: FileMetadata = [...metadata];
      updated[H.MTIME] = 9999999;
      recrawledFewChanges.set(filePath, updated);
      modified++;
    }
  }

  const emptyTfs = new TreeFS({
    rootDir: '/project',
    processFile: () => {
      throw new Error('Not implemented');
    },
  });

  const results = [
    // Construction
    [
      'bulkAddOrModify (construct)',
      bench(() => newTfs(), 50),
      50,
    ],

    // lookup through symlinks
    [
      'lookup (hoisted symlinks)',
      bench(() => {
        for (let i = 0; i < hoistedLookupPaths.length; i++) {
          tfs.lookup(hoistedLookupPaths[i]);
        }
      }, ITERATIONS / hoistedLookupPaths.length),
      ITERATIONS,
    ],

    // lookup direct source files (no symlinks)
    [
      'lookup (source, no symlinks)',
      bench(() => {
        for (let i = 0; i < sourceLookupPaths.length; i++) {
          tfs.lookup(sourceLookupPaths[i]);
        }
      }, ITERATIONS / sourceLookupPaths.length),
      ITERATIONS,
    ],

    // lookup deep .pnpm store paths
    [
      'lookup (deep .pnpm paths)',
      bench(() => {
        for (let i = 0; i < deepLookupPaths.length; i++) {
          tfs.lookup(deepLookupPaths[i]);
        }
      }, ITERATIONS / deepLookupPaths.length),
      ITERATIONS,
    ],

    // exists through symlinks
    [
      'exists (through symlinks)',
      bench(() => {
        for (let i = 0; i < hoistedLookupPaths.length; i++) {
          tfs.exists(hoistedLookupPaths[i]);
        }
      }, ITERATIONS / hoistedLookupPaths.length),
      ITERATIONS,
    ],

    // exists missing files (negative lookups)
    [
      'exists (missing files)',
      bench(() => {
        for (let i = 0; i < missingPaths.length; i++) {
          tfs.exists(missingPaths[i]);
        }
      }, ITERATIONS / missingPaths.length),
      ITERATIONS,
    ],

    // hierarchicalLookup through symlinks
    [
      'hierarchicalLookup (symlinks)',
      bench(() => {
        for (let i = 0; i < hierarchicalStartPaths.length; i++) {
          tfs.hierarchicalLookup(
            hierarchicalStartPaths[i],
            'package.json',
            {
              breakOnSegment: 'node_modules',
              invalidatedBy: null,
              subpathType: 'f',
            },
          );
        }
      }, ITERATIONS / hierarchicalStartPaths.length),
      ITERATIONS,
    ],

    // getDifference: no changes (warm start fast path)
    [
      'getDifference (no changes)',
      bench(() => tfs.getDifference(recrawled), 200),
      200,
    ],

    // getDifference: 1% changed
    [
      'getDifference (1% changed)',
      bench(() => tfs.getDifference(recrawledFewChanges), 200),
      200,
    ],

    // getDifference: cold start (empty tree)
    [
      'getDifference (cold start)',
      bench(() => emptyTfs.getDifference(layout.files), 200),
      200,
    ],

    // matchFiles with symlink following over node_modules
    [
      'matchFiles (follow, node_modules)',
      bench(
        () =>
          Array.from(
            tfs.matchFiles({
              filter: /\.js$/,
              follow: true,
              recursive: true,
              rootDir: '/project/node_modules',
            }),
          ),
        100,
      ),
      100,
    ],

    // matchFiles without following symlinks
    [
      'matchFiles (no follow, all)',
      bench(
        () =>
          Array.from(
            tfs.matchFiles({
              filter: /\.js$/,
              follow: false,
              recursive: true,
            }),
          ),
        100,
      ),
      100,
    ],
  ];

  const total = results.reduce((sum, [, ms]) => sum + ms, 0);
  const pad = (s: string, n: number) =>
    s + ' '.repeat(Math.max(0, n - s.length));

  const lines = [
    `TreeFS pnpm benchmark (${layout.files.size} files, ${layout.hoistedSymlinkPaths.length} symlinks, preResolved=${String(preResolved)})`,
    '',
    ...results.map(([label, ms, iters]) => {
      const opsPerMs = (iters / ms).toFixed(1);
      return `  ${pad(label, 36)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${opsPerMs} ops/ms)`;
    }),
    `  ${'-'.repeat(70)}`,
    `  ${pad('Total', 36)} ${total.toFixed(2).padStart(10)}ms`,
  ];

  console.log('\n' + lines.join('\n') + '\n');

  expect(total).toBeGreaterThan(0);
});
