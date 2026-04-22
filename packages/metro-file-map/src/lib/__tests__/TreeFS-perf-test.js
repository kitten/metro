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
const LOOKUP_ITERATIONS = 20_000;

/**
 * Detect whether TreeFS expects pre-resolved (normal) symlink targets, or
 * literal (relative/absolute) targets resolved at runtime.
 */
function detectSymlinkMode(TreeFS: $FlowFixMe): boolean {
  const probe = new TreeFS({
    rootDir: '/probe',
    files: new Map([
      ['dir/target.js', [1, 1, 0, null, 0, null]],
      ['dir/link.js', [0, 0, 0, null, 'target.js', null]],
    ]),
    processFile: () => null,
  });
  const result = probe.lookup('/probe/dir/link.js');
  return !result.exists;
}

/**
 * Generate a pnpm-like isolated-install layout.
 *
 * Physical files under .pnpm store, hoisted symlinks in node_modules,
 * and peer-dep symlinks within .pnpm (every 3rd package).
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

  for (let i = 0; i < NUM_SOURCE_FILES; i++) {
    const dir = `src/features/feature${Math.floor(i / 10)}`;
    const filePath = `${dir}/file${i}.js`;
    files.set(filePath, [1000000 + i, 100 + i, 0, null, 0, null]);
    sourceFilePaths.push(filePath);
  }

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

  for (const pkgName of packageNames) {
    const symlinkPath = `node_modules/${pkgName}`;
    const target = preResolved
      ? `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`
      : `.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;
    files.set(symlinkPath, [0, 0, 0, null, target, null]);
    hoistedSymlinkPaths.push(symlinkPath);
  }

  for (let i = 0; i < packageNames.length; i++) {
    if (i % 3 !== 0) continue;
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

/**
 * Simulate the cold-start crawl result from the node crawler.
 *
 * On this branch, cold-start crawl skips lstat (mtime=null, size=0) and sets
 * symlinks to H.SYMLINK=1 (unresolved). On main, all files have mtime/size
 * from lstat, and symlinks have H.SYMLINK=1 (also unresolved until readlink
 * in #applyFileDelta or #resolveSymlinkTargetToNormalPath).
 *
 * If deferStat=false, simulate main's behavior with mtime populated.
 */
function simulateColdCrawl(
  fullLayout: FileData,
  deferStat: boolean,
): FileData {
  const crawled: FileData = new Map();
  for (const [normalPath, metadata] of fullLayout) {
    if (deferStat) {
      // Branch behavior: no lstat, no readlink during crawl
      const isSymlink = metadata[H.SYMLINK] !== 0;
      crawled.set(normalPath, [null, 0, 0, null, isSymlink ? 1 : 0, null]);
    } else {
      // Main behavior: lstat populates mtime/size, readlink not yet done
      const isSymlink = metadata[H.SYMLINK] !== 0;
      crawled.set(normalPath, [
        metadata[H.MTIME],
        metadata[H.SIZE],
        0,
        null,
        isSymlink ? 1 : 0,
        null,
      ]);
    }
  }
  return crawled;
}

/**
 * Simulate a warm-start crawl: re-crawl the same files. On the branch,
 * previously-unseen files still have mtime=null so the crawler skips lstat
 * again. Files that were accessed (and thus stat'd) would have real mtimes.
 */
function simulateWarmCrawl(
  fullLayout: FileData,
  tfs: $FlowFixMe,
  deferStat: boolean,
): FileData {
  const crawled: FileData = new Map();
  for (const [normalPath, metadata] of fullLayout) {
    const isSymlink = metadata[H.SYMLINK] !== 0;
    if (deferStat) {
      // Check what the current tree has for mtime (simulates getMtimeByNormalPath)
      const cachedMtime = tfs.getMtimeByNormalPath?.(normalPath);
      if (cachedMtime == null || cachedMtime === 0) {
        crawled.set(normalPath, [null, 0, 0, null, isSymlink ? 1 : 0, null]);
      } else {
        // File was previously stat'd, re-stat gives same mtime
        crawled.set(normalPath, [
          metadata[H.MTIME],
          metadata[H.SIZE],
          0,
          null,
          isSymlink ? 1 : 0,
          null,
        ]);
      }
    } else {
      crawled.set(normalPath, [
        metadata[H.MTIME],
        metadata[H.SIZE],
        0,
        null,
        isSymlink ? 1 : 0,
        null,
      ]);
    }
  }
  return crawled;
}

function bench(fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(1000, Math.floor(iterations / 10)); i++) {
    fn();
  }
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return performance.now() - start;
}

test('benchmark: build lifecycle (crawl → lookup → warm crawl)', () => {
  jest.useRealTimers();
  jest.resetModules();
  mockPathModule = jest.requireActual<{}>('path').posix;

  const TreeFS = require('../TreeFS').default;

  const preResolved = detectSymlinkMode(TreeFS);
  const hasDeferStat = typeof TreeFS.prototype.getMtimeByNormalPath === 'function';
  const layout = generatePnpmLayout(preResolved);

  // Sanity check
  const sanityTfs = new TreeFS({
    rootDir: '/project',
    files: layout.files,
    processFile: () => null,
  });
  const sanity = sanityTfs.lookup('/project/node_modules/pkg-000/index.js');
  if (!sanity.exists) {
    throw new Error(
      `Sanity check failed. preResolved=${String(preResolved)}`,
    );
  }

  // --- Phase 1: Cold start crawl + build TreeFS ---
  const coldCrawl = simulateColdCrawl(layout.files, hasDeferStat);

  const coldGetDiff = bench(() => {
    const emptyTfs = new TreeFS({
      rootDir: '/project',
      processFile: () => null,
    });
    emptyTfs.getDifference(coldCrawl);
  }, 200);

  const coldBuild = bench(() => {
    // eslint-disable-next-line no-new
    new TreeFS({
      rootDir: '/project',
      files: coldCrawl,
      processFile: () => null,
    });
  }, 100);

  // Build the "live" tree for subsequent phases.
  // Always use the full layout (with resolved symlink targets) so that
  // lookup benchmarks are meaningful — in real usage, symlink targets get
  // populated via readlinkSync (lazy) or during #applyFileDelta.
  const tfs = new TreeFS({
    rootDir: '/project',
    files: layout.files,
    processFile: () => null,
  });

  // --- Phase 2: Lookup (simulates resolution during bundling) ---
  const hoistedLookupPaths = layout.hoistedSymlinkPaths.map(
    link => '/project/' + link + '/index.js',
  );
  const sourceLookupPaths = layout.sourceFilePaths.map(f => '/project/' + f);
  const hierarchicalPaths = layout.hoistedSymlinkPaths.map(
    link => '/project/' + link + '/lib/helper0.js',
  );

  const lookupSymlinks = bench(() => {
    for (let i = 0; i < hoistedLookupPaths.length; i++) {
      tfs.lookup(hoistedLookupPaths[i]);
    }
  }, LOOKUP_ITERATIONS / hoistedLookupPaths.length);

  const lookupSource = bench(() => {
    for (let i = 0; i < sourceLookupPaths.length; i++) {
      tfs.lookup(sourceLookupPaths[i]);
    }
  }, LOOKUP_ITERATIONS / sourceLookupPaths.length);

  const hierarchicalLookup = bench(() => {
    for (let i = 0; i < hierarchicalPaths.length; i++) {
      tfs.hierarchicalLookup(hierarchicalPaths[i], 'package.json', {
        breakOnSegment: 'node_modules',
        invalidatedBy: null,
        subpathType: 'f',
      });
    }
  }, LOOKUP_ITERATIONS / hierarchicalPaths.length);

  // --- Phase 3: Warm start crawl ---
  const warmCrawl = simulateWarmCrawl(layout.files, tfs, hasDeferStat);

  const warmGetDiff = bench(() => {
    tfs.getDifference(warmCrawl);
  }, 200);

  const warmBuild = bench(() => {
    // eslint-disable-next-line no-new
    new TreeFS({
      rootDir: '/project',
      files: warmCrawl,
      processFile: () => null,
    });
  }, 100);

  // --- Phase 4: matchFiles (e.g. require.context) ---
  const matchFollow = bench(
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
  );

  const matchNoFollow = bench(
    () =>
      Array.from(
        tfs.matchFiles({
          filter: /\.js$/,
          follow: false,
          recursive: true,
        }),
      ),
    100,
  );

  // --- Results ---
  const results: Array<[string, number, number]> = [
    ['Cold getDifference', coldGetDiff, 200],
    ['Cold bulkAddOrModify', coldBuild, 100],
    ['Lookup (symlinks)', lookupSymlinks, LOOKUP_ITERATIONS],
    ['Lookup (source)', lookupSource, LOOKUP_ITERATIONS],
    ['hierarchicalLookup', hierarchicalLookup, LOOKUP_ITERATIONS],
    ['Warm getDifference', warmGetDiff, 200],
    ['Warm bulkAddOrModify', warmBuild, 100],
    ['matchFiles (follow)', matchFollow, 100],
    ['matchFiles (no follow)', matchNoFollow, 100],
  ];

  const total = results.reduce((sum, [, ms]) => sum + ms, 0);
  const pad = (s: string, n: number) =>
    s + ' '.repeat(Math.max(0, n - s.length));

  const features = [
    preResolved ? 'preResolved' : 'runtimeResolve',
    hasDeferStat ? 'deferStat' : 'eagerStat',
  ].join(', ');

  const lines = [
    `TreeFS build lifecycle (${layout.files.size} files, ${layout.hoistedSymlinkPaths.length} symlinks; ${features})`,
    '',
    '  Phase 1: Cold start',
    ...results
      .slice(0, 2)
      .map(
        ([label, ms, iters]) =>
          `    ${pad(label, 32)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${(iters / ms).toFixed(1)} ops/ms)`,
      ),
    '',
    '  Phase 2: Lookups (bundling)',
    ...results
      .slice(2, 5)
      .map(
        ([label, ms, iters]) =>
          `    ${pad(label, 32)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${(iters / ms).toFixed(1)} ops/ms)`,
      ),
    '',
    '  Phase 3: Warm start',
    ...results
      .slice(5, 7)
      .map(
        ([label, ms, iters]) =>
          `    ${pad(label, 32)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${(iters / ms).toFixed(1)} ops/ms)`,
      ),
    '',
    '  Phase 4: matchFiles',
    ...results
      .slice(7)
      .map(
        ([label, ms, iters]) =>
          `    ${pad(label, 32)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${(iters / ms).toFixed(1)} ops/ms)`,
      ),
    '',
    `  ${'-'.repeat(66)}`,
    `  ${pad('Total', 36)} ${total.toFixed(2).padStart(10)}ms`,
  ];

  console.log('\n' + lines.join('\n') + '\n');

  expect(total).toBeGreaterThan(0);
});
