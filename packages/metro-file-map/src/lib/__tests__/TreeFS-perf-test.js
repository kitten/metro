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

import type {FileData} from '../../flow-types';

import H from '../../constants';

let mockPathModule;
jest.mock('path', () => mockPathModule);

// Tunables for the generated fixture.
const NUM_SOURCE_FILES = 500;
const NUM_PACKAGES = 200;
const FILES_PER_PACKAGE = 8;
const LOOKUP_ITERATIONS = 20_000;
const SYMLINK_UTILIZATION = 0.3;

/**
 * Create a pnpm-like isolated-install layout on disk with real files and
 * symlinks. Returns both cold crawl data (mtime=null, H.SYMLINK=1) and
 * pre-resolved data (mtime populated, H.SYMLINK=normal path) for different
 * benchmark phases.
 */
function createFixture(
  rootDir: string,
  fs: $FlowFixMe,
  pathMod: $FlowFixMe,
): {
  coldFiles: FileData,
  resolvedFiles: FileData,
  sourceFilePaths: Array<string>,
  hoistedSymlinkPaths: Array<string>,
  allSymlinkPaths: Array<string>,
  totalSymlinks: number,
} {
  const coldFiles: FileData = new Map();
  const resolvedFiles: FileData = new Map();
  const sourceFilePaths: Array<string> = [];
  const hoistedSymlinkPaths: Array<string> = [];
  const allSymlinkPaths: Array<string> = [];
  let totalSymlinks = 0;

  // Source files
  for (let i = 0; i < NUM_SOURCE_FILES; i++) {
    const dir = `src/features/feature${Math.floor(i / 10)}`;
    const filePath = `${dir}/file${i}.js`;
    fs.mkdirSync(pathMod.join(rootDir, dir), {recursive: true});
    fs.writeFileSync(pathMod.join(rootDir, filePath), '');
    coldFiles.set(filePath, [null, 0, 0, null, 0, null]);
    resolvedFiles.set(filePath, [1000000 + i, 100 + i, 0, null, 0, null]);
    sourceFilePaths.push(filePath);
  }

  for (const name of [
    'index.js',
    'app.js',
    'metro.config.js',
    'package.json',
  ]) {
    fs.writeFileSync(pathMod.join(rootDir, name), '');
    coldFiles.set(name, [null, 0, 0, null, 0, null]);
    resolvedFiles.set(name, [1000000, 50, 0, null, 0, null]);
    sourceFilePaths.push(name);
  }

  // Package store files
  const packageNames: Array<string> = [];
  for (let i = 0; i < NUM_PACKAGES; i++) {
    packageNames.push(`pkg-${String(i).padStart(3, '0')}`);
  }

  for (const pkgName of packageNames) {
    const storeBase = `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;
    fs.mkdirSync(pathMod.join(rootDir, storeBase, 'lib'), {recursive: true});

    const pkgJson = `${storeBase}/package.json`;
    fs.writeFileSync(pathMod.join(rootDir, pkgJson), '{}');
    coldFiles.set(pkgJson, [null, 0, 0, null, 0, null]);
    resolvedFiles.set(pkgJson, [2000000, 200, 0, null, 0, null]);

    const indexJs = `${storeBase}/index.js`;
    fs.writeFileSync(pathMod.join(rootDir, indexJs), '');
    coldFiles.set(indexJs, [null, 0, 0, null, 0, null]);
    resolvedFiles.set(indexJs, [2000000, 150, 0, null, 0, null]);

    for (let f = 0; f < FILES_PER_PACKAGE - 2; f++) {
      const libFile = `${storeBase}/lib/helper${f}.js`;
      fs.writeFileSync(pathMod.join(rootDir, libFile), '');
      coldFiles.set(libFile, [null, 0, 0, null, 0, null]);
      resolvedFiles.set(libFile, [2000000, 80 + f, 0, null, 0, null]);
    }
  }

  // Hoisted symlinks: node_modules/pkg -> .pnpm/pkg@1.0.0/node_modules/pkg
  for (const pkgName of packageNames) {
    const symlinkPath = `node_modules/${pkgName}`;
    const literalTarget = `.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;
    const resolvedTarget = `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${pkgName}`;
    fs.symlinkSync(literalTarget, pathMod.join(rootDir, symlinkPath));
    coldFiles.set(symlinkPath, [null, 0, 0, null, 1, null]);
    resolvedFiles.set(symlinkPath, [0, 0, 0, null, resolvedTarget, null]);
    hoistedSymlinkPaths.push(symlinkPath);
    allSymlinkPaths.push(symlinkPath);
    totalSymlinks++;
  }

  // Peer-dep symlinks within .pnpm (every 3rd package)
  for (let i = 0; i < packageNames.length; i++) {
    if (i % 3 !== 0) continue;
    const pkgName = packageNames[i];
    const peerName = packageNames[(i + 1) % packageNames.length];
    const peerSymlinkPath = `node_modules/.pnpm/${pkgName}@1.0.0/node_modules/${peerName}`;
    const literalTarget = `../../${peerName}@1.0.0/node_modules/${peerName}`;
    const resolvedTarget = `node_modules/.pnpm/${peerName}@1.0.0/node_modules/${peerName}`;
    fs.symlinkSync(literalTarget, pathMod.join(rootDir, peerSymlinkPath));
    coldFiles.set(peerSymlinkPath, [null, 0, 0, null, 1, null]);
    resolvedFiles.set(
      peerSymlinkPath,
      [0, 0, 0, null, resolvedTarget, null],
    );
    allSymlinkPaths.push(peerSymlinkPath);
    totalSymlinks++;
  }

  return {
    coldFiles,
    resolvedFiles,
    sourceFilePaths,
    hoistedSymlinkPaths,
    allSymlinkPaths,
    totalSymlinks,
  };
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

test('benchmark: realistic I/O with symlinks on disk', () => {
  jest.useRealTimers();
  jest.resetModules();
  mockPathModule = jest.requireActual<{}>('path').posix;

  const TreeFS = require('../TreeFS').default;
  const realFs: $FlowFixMe = jest.requireActual<{}>('fs');
  const realPath: $FlowFixMe = jest.requireActual<{}>('path');
  const {tmpdir}: $FlowFixMe = jest.requireActual<{}>('os');

  const hasDeferStat =
    typeof TreeFS.prototype.getMtimeByNormalPath === 'function';

  const rootDir: string = realFs.mkdtempSync(
    realPath.join(tmpdir(), 'treefs-bench-'),
  );

  try {
    const setupStart = performance.now();
    const fixture = createFixture(rootDir, realFs, realPath);
    const setupTime = performance.now() - setupStart;

    const totalFiles = fixture.coldFiles.size;
    const totalRegular = totalFiles - fixture.totalSymlinks;
    const peerSymlinks =
      fixture.totalSymlinks - fixture.hoistedSymlinkPaths.length;
    const usedCount = Math.floor(
      fixture.hoistedSymlinkPaths.length * SYMLINK_UTILIZATION,
    );

    // --- Sanity check ---
    const sanityTfs = new TreeFS({
      rootDir,
      files: fixture.resolvedFiles,
      processFile: () => null,
    });
    const sanity = sanityTfs.lookup(
      realPath.join(rootDir, 'node_modules/pkg-000/index.js'),
    );
    if (!sanity.exists) {
      throw new Error('Sanity check failed: resolved symlink lookup');
    }

    // --- Section 1: Direct I/O cost measurement ---
    const allAbsPaths = Array.from(fixture.coldFiles.keys()).map(p =>
      realPath.join(rootDir, p),
    );
    const symlinkAbsPaths = fixture.allSymlinkPaths.map(p =>
      realPath.join(rootDir, p),
    );

    // Warmup pass (fill OS page cache)
    for (const p of allAbsPaths) {
      try {
        realFs.lstatSync(p);
      } catch {}
    }
    for (const p of symlinkAbsPaths) {
      try {
        realFs.readlinkSync(p);
      } catch {}
    }

    const lstatStart = performance.now();
    for (const p of allAbsPaths) {
      realFs.lstatSync(p);
    }
    const lstatTime = performance.now() - lstatStart;

    const readlinkStart = performance.now();
    for (const p of symlinkAbsPaths) {
      realFs.readlinkSync(p);
    }
    const readlinkTime = performance.now() - readlinkStart;

    // --- Section 2: In-memory benchmarks (pre-resolved, no I/O) ---
    const tfs = new TreeFS({
      rootDir,
      files: fixture.resolvedFiles,
      processFile: () => null,
    });

    const hoistedLookupPaths = fixture.hoistedSymlinkPaths.map(
      link => realPath.join(rootDir, link, 'index.js'),
    );
    const sourceLookupPaths = fixture.sourceFilePaths.map(f =>
      realPath.join(rootDir, f),
    );
    const hierarchicalPaths = fixture.hoistedSymlinkPaths.map(
      link => realPath.join(rootDir, link, 'lib/helper0.js'),
    );

    const coldGetDiff = bench(() => {
      const emptyTfs = new TreeFS({
        rootDir,
        processFile: () => null,
      });
      emptyTfs.getDifference(fixture.coldFiles);
    }, 200);

    const coldBuild = bench(() => {
      // eslint-disable-next-line no-new
      new TreeFS({
        rootDir,
        files: fixture.coldFiles,
        processFile: () => null,
      });
    }, 100);

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

    const matchFollow = bench(
      () =>
        Array.from(
          tfs.matchFiles({
            filter: /\.js$/,
            follow: true,
            recursive: true,
            rootDir: realPath.join(rootDir, 'node_modules'),
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

    // --- Section 3: Lazy resolution with real I/O (branch only) ---
    let coldBuildTime = 0;
    let lazyPartialTime = 0;
    let lazyCachedTime = 0;
    let lazyRemainingTime = 0;
    let lazyResolved = 0;

    if (hasDeferStat) {
      // Deep clone cold files — lookup mutates H.SYMLINK from 1 to resolved
      const coldClone: FileData = new Map();
      for (const [k, v] of fixture.coldFiles) {
        coldClone.set(k, ([v[0], v[1], v[2], v[3], v[4], v[5]]: $FlowFixMe));
      }

      const buildStart = performance.now();
      const coldTfs = new TreeFS({
        rootDir,
        files: coldClone,
        processFile: () => null,
      });
      coldBuildTime = performance.now() - buildStart;

      // Lookup 30% of packages — each triggers a real readlinkSync
      const usedPaths = fixture.hoistedSymlinkPaths.slice(0, usedCount);
      const partialStart = performance.now();
      for (const link of usedPaths) {
        const result = coldTfs.lookup(
          realPath.join(rootDir, link, 'index.js'),
        );
        if (result.exists) lazyResolved++;
      }
      lazyPartialTime = performance.now() - partialStart;

      // Lookup same 30% again — cached, no I/O
      const cachedStart = performance.now();
      for (const link of usedPaths) {
        coldTfs.lookup(realPath.join(rootDir, link, 'index.js'));
      }
      lazyCachedTime = performance.now() - cachedStart;

      // Lookup remaining 70% — each triggers readlinkSync
      const remainingPaths = fixture.hoistedSymlinkPaths.slice(usedCount);
      const remainingStart = performance.now();
      for (const link of remainingPaths) {
        coldTfs.lookup(realPath.join(rootDir, link, 'index.js'));
      }
      lazyRemainingTime = performance.now() - remainingStart;
    }

    // --- Format results ---
    const pad = (s: string, n: number) =>
      s + ' '.repeat(Math.max(0, n - s.length));

    const lstatUs = ((lstatTime / totalFiles) * 1000).toFixed(1);
    const readlinkUs =
      ((readlinkTime / fixture.totalSymlinks) * 1000).toFixed(1);

    const inMemResults: Array<[string, number, number]> = [
      ['Cold getDifference', coldGetDiff, 200],
      ['Cold bulkAddOrModify', coldBuild, 100],
      ['Lookup (symlinks)', lookupSymlinks, LOOKUP_ITERATIONS],
      ['Lookup (source)', lookupSource, LOOKUP_ITERATIONS],
      ['hierarchicalLookup', hierarchicalLookup, LOOKUP_ITERATIONS],
      ['matchFiles (follow)', matchFollow, 100],
      ['matchFiles (no follow)', matchNoFollow, 100],
    ];
    const inMemTotal = inMemResults.reduce((sum, [, ms]) => sum + ms, 0);

    const features = hasDeferStat
      ? 'preResolved, deferStat'
      : 'runtimeResolve, eagerStat';

    const lines = [
      `TreeFS benchmark (${totalFiles} entries on disk: ${totalRegular} files, ` +
        `${fixture.hoistedSymlinkPaths.length} hoisted + ${peerSymlinks} peer symlinks; ${features})`,
      `  Fixture: ${rootDir} (created in ${setupTime.toFixed(0)}ms)`,
      '',
      '  Direct I/O cost (warm OS cache):',
      `    ${pad(`lstat x ${totalFiles}`, 36)} ${lstatTime.toFixed(2).padStart(10)}ms  (${lstatUs} \u00b5s/call)`,
      `    ${pad(`readlinkSync x ${fixture.totalSymlinks}`, 36)} ${readlinkTime.toFixed(2).padStart(10)}ms  (${readlinkUs} \u00b5s/call)`,
    ];

    if (hasDeferStat) {
      lines.push(
        '',
        `  Lazy symlink resolution (real I/O, ${(SYMLINK_UTILIZATION * 100).toFixed(0)}% utilization):`,
        `    ${pad('Build TreeFS (cold crawl data)', 36)} ${coldBuildTime.toFixed(2).padStart(10)}ms`,
        `    ${pad(`Lookup ${usedCount} pkgs (+readlinkSync)`, 36)} ${lazyPartialTime.toFixed(2).padStart(10)}ms  (${lazyResolved}/${usedCount} resolved)`,
        `    ${pad(`Lookup ${usedCount} pkgs (cached)`, 36)} ${lazyCachedTime.toFixed(2).padStart(10)}ms`,
        `    ${pad(`Lookup ${fixture.hoistedSymlinkPaths.length - usedCount} remaining (+readlinkSync)`, 36)} ${lazyRemainingTime.toFixed(2).padStart(10)}ms`,
      );
    }

    lines.push(
      '',
      '  In-memory operations (pre-resolved, iterated):',
      ...inMemResults.map(
        ([label, ms, iters]) =>
          `    ${pad(label, 32)} ${ms.toFixed(2).padStart(10)}ms  (${iters} iters, ${(iters / ms).toFixed(1)} ops/ms)`,
      ),
      `    ${pad('Total', 32)} ${inMemTotal.toFixed(2).padStart(10)}ms`,
    );

    if (hasDeferStat) {
      // Estimated I/O for main: lstat all files (cold + warm) + readlink all symlinks
      const mainIoTime = lstatTime * 2 + readlinkTime;
      // Branch I/O at 30% utilization: only the readlinkSync calls during partial lookup
      const branchEstReadlink =
        readlinkTime * (usedCount / fixture.totalSymlinks);
      const pct = ((1 - branchEstReadlink / mainIoTime) * 100).toFixed(1);

      lines.push(
        '',
        '  Estimated lifecycle I/O cost (cold crawl + bundle + warm recrawl):',
        `    Main:   ${totalFiles} lstats + ${fixture.totalSymlinks} readlinks + ${totalFiles} lstats` +
          ` = ${mainIoTime.toFixed(2)}ms`,
        `    Branch: ${usedCount} readlinkSync (${(SYMLINK_UTILIZATION * 100).toFixed(0)}% util.)` +
          ` = ${branchEstReadlink.toFixed(2)}ms  (-${pct}%)`,
      );
    }

    console.log('\n' + lines.join('\n') + '\n');

    expect(inMemTotal).toBeGreaterThan(0);
    if (hasDeferStat) {
      expect(lazyResolved).toBe(usedCount);
    }
  } finally {
    realFs.rmSync(rootDir, {recursive: true, force: true});
  }
});
