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

import type {
  Console,
  CrawlerOptions,
  CrawlResult,
  FileData,
  IgnoreMatcher,
} from '../../flow-types';

import H from '../../constants';
import {RootPathUtils} from '../../lib/RootPathUtils';
import hasNativeFindSupport from './hasNativeFindSupport';
import {spawn} from 'child_process';
import * as fs from 'fs';
import {platform} from 'os';
import * as path from 'path';

// eslint-disable-next-line import/no-commonjs
const debug = require('debug')('Metro:NodeCrawler');

type Callback = (result: FileData) => void;

function find(
  roots: ReadonlyArray<string>,
  extensions: ReadonlyArray<string>,
  ignore: IgnoreMatcher,
  includeSymlinks: boolean,
  rootDir: string,
  console: Console,
  callback: Callback,
): void {
  const result: FileData = new Map();
  let activeCalls = 0;
  const pathUtils = new RootPathUtils(rootDir);

  function search(directory: string): void {
    activeCalls++;
    fs.readdir(directory, {withFileTypes: true}, (err, entries) => {
      activeCalls--;
      if (err) {
        console.warn(
          `Error "${err.code ?? err.message}" reading contents of "${directory}", skipping. Add this directory to your ignore list to exclude it.`,
        );
      } else {
        entries.forEach((entry: fs.Dirent) => {
          const file = path.join(directory, entry.name.toString());

          if (ignore(file)) {
            return;
          }

          if (entry.isSymbolicLink() && !includeSymlinks) {
            return;
          }

          if (entry.isDirectory()) {
            search(file);
            return;
          }

          activeCalls++;

          fs.lstat(file, (err, stat) => {
            activeCalls--;

            if (!err && stat) {
              const ext = path.extname(file).substr(1);
              if (stat.isSymbolicLink() || extensions.includes(ext)) {
                result.set(pathUtils.absoluteToNormal(file), [
                  stat.mtime.getTime(),
                  stat.size,
                  0,
                  null,
                  stat.isSymbolicLink() ? 1 : 0,
                  null,
                ]);
              }
            }

            if (activeCalls === 0) {
              callback(result);
            }
          });
        });
      }

      if (activeCalls === 0) {
        callback(result);
      }
    });
  }

  if (roots.length > 0) {
    roots.forEach(search);
  } else {
    callback(result);
  }
}

function findNative(
  roots: ReadonlyArray<string>,
  extensions: ReadonlyArray<string>,
  ignore: IgnoreMatcher,
  includeSymlinks: boolean,
  rootDir: string,
  console: Console,
  callback: Callback,
): void {
  // Examples:
  // ( ( -type f ( -iname *.js ) ) )
  // ( ( -type f ( -iname *.js -o -iname *.ts ) ) )
  // ( ( -type f ( -iname *.js ) ) -o -type l )
  // ( ( -type f ) -o -type l )
  const extensionClause = extensions.length
    ? `( ${extensions.map(ext => `-iname *.${ext}`).join(' -o ')} )`
    : ''; // Empty inner expressions eg "( )" are not allowed
  const expression = `( ( -type f ${extensionClause} ) ${
    includeSymlinks ? '-o -type l ' : ''
  })`;

  const pathUtils = new RootPathUtils(rootDir);

  const child = spawn('find', roots.concat(expression.split(' ')));
  let stdout = '';
  if (child.stdout == null) {
    throw new Error(
      'stdout is null - this should never happen. Please open up an issue at https://github.com/facebook/metro',
    );
  }
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', data => (stdout += data));

  child.stdout.on('close', () => {
    const lines = stdout
      .trim()
      .split('\n')
      .filter(x => !ignore(x));
    const result: FileData = new Map();
    let count = lines.length;
    if (!count) {
      callback(new Map());
    } else {
      lines.forEach(path => {
        fs.lstat(path, (err, stat) => {
          if (!err && stat) {
            result.set(pathUtils.absoluteToNormal(path), [
              stat.mtime.getTime(),
              stat.size,
              0,
              null,
              stat.isSymbolicLink() ? 1 : 0,
              null,
            ]);
          }
          if (--count === 0) {
            callback(result);
          }
        });
      });
    }
  });
}

/**
 * Crawl the filesystem using readdir with Dirent entries, without calling
 * lstat on each file. Produces FileMetadata with null mtime and zero size.
 * Symlinks are detected via Dirent.isSymbolicLink().
 */
function findWithoutStat(
  roots: ReadonlyArray<string>,
  extensions: ReadonlyArray<string>,
  ignore: IgnoreMatcher,
  includeSymlinks: boolean,
  rootDir: string,
  console: Console,
  callback: Callback,
): void {
  const result: FileData = new Map();
  let activeCalls = 0;
  const pathUtils = new RootPathUtils(rootDir);

  function search(directory: string, dirNormal: string): void {
    activeCalls++;
    fs.readdir(directory, {withFileTypes: true}, (err, entries) => {
      activeCalls--;
      if (err) {
        console.warn(
          `Error "${err.code ?? err.message}" reading contents of "${directory}", skipping. Add this directory to your ignore list to exclude it.`,
        );
      } else {
        entries.forEach((entry: fs.Dirent) => {
          const name = entry.name.toString();
          const file = directory + path.sep + name;

          if (ignore(file)) {
            return;
          }

          if (entry.isSymbolicLink() && !includeSymlinks) {
            return;
          }

          // Build the normal path incrementally — avoids calling
          // absoluteToNormal per file.
          const fileNormal =
            dirNormal === '' ? name : dirNormal + path.sep + name;

          if (entry.isDirectory()) {
            search(file, fileNormal);
            return;
          }

          const isSymlink = entry.isSymbolicLink();
          const ext = path.extname(name).substr(1);
          if (isSymlink || extensions.includes(ext)) {
            result.set(fileNormal, [
              null, // H.MTIME — deferred to getDifference
              0, // H.SIZE — unknown
              0, // H.VISITED
              null, // H.SHA1
              isSymlink ? 1 : 0, // H.SYMLINK — from Dirent
              null, // H.PLUGINDATA
            ]);
          }
        });
      }

      if (activeCalls === 0) {
        callback(result);
      }
    });
  }

  if (roots.length > 0) {
    roots.forEach(root => search(root, pathUtils.absoluteToNormal(root)));
  } else {
    callback(result);
  }
}

/**
 * Async batch stat for files that exist in the previous filesystem.
 * On cold start (empty previous FS), this is a no-op — zero stat calls.
 * On warm start, stats cached files in parallel to populate mtime/size
 * so that getDifference can do pure in-memory comparison.
 */
async function asyncStatKnownFiles(
  fileData: FileData,
  previousFileSystem: CrawlerOptions['previousState']['fileSystem'],
  rootDir: string,
): Promise<void> {
  const pathUtils = new RootPathUtils(rootDir);
  const promises: Array<Promise<void>> = [];

  const externalPrefix = '..' + path.sep;
  for (const [normalPath, metadata] of fileData) {
    if (metadata[H.SYMLINK] !== 0) {
      continue;
    } else if (metadata[H.MTIME] != null && metadata[H.MTIME] > 0) {
      continue;
    } else if (normalPath.startsWith(externalPrefix)) {
      // Skip reading mtime for files outside of project root
      continue;
    }

    const absolutePath = pathUtils.normalToAbsolute(normalPath);
    if (!previousFileSystem.exists(absolutePath)) {
      continue;
    }

    promises.push(
      fs.promises.lstat(absolutePath).then(
        (stat) => {
          metadata[H.MTIME] = stat.mtime.getTime();
          metadata[H.SIZE] = stat.size;
        },
        () => {
          fileData.delete(normalPath);
        },
      ),
    );
  }

  await Promise.all(promises);
}

export default async function nodeCrawl(
  options: CrawlerOptions,
): Promise<CrawlResult> {
  const skipStat = !!options.skipStat;
  const {
    console,
    previousState,
    extensions,
    forceNodeFilesystemAPI,
    ignore,
    rootDir,
    includeSymlinks,
    perfLogger,
    roots,
    abortSignal,
    subpath,
  } = options;

  abortSignal?.throwIfAborted();
  perfLogger?.point('nodeCrawl_start');
  debug('Using skipStat: %s', !!skipStat);

  let crawlFn: typeof find | typeof findNative | typeof findWithoutStat;
  if (skipStat) {
    crawlFn = findWithoutStat;
  } else if (
    !forceNodeFilesystemAPI &&
    platform() !== 'win32' &&
    (await hasNativeFindSupport())
  ) {
    crawlFn = findNative;
  } else {
    crawlFn = find;
  }

  // (1): Discover files
  const fileData = await new Promise<FileData>(resolve => {
    crawlFn(roots, extensions, ignore, includeSymlinks, rootDir, console, resolve);
  });

  perfLogger?.point('nodeCrawl_afterCrawl');
  abortSignal?.throwIfAborted();

  // (2): Async stat for files that exist in the previous filesystem.
  if (skipStat) {
    await asyncStatKnownFiles(fileData, previousState.fileSystem, rootDir);
    perfLogger?.point('nodeCrawl_afterStat');
    abortSignal?.throwIfAborted();
  }

  const difference = previousState.fileSystem.getDifference(fileData, {
    subpath,
  });

  perfLogger?.point('nodeCrawl_end');
  return difference;
}
