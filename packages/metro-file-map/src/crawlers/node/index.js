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

import {RootPathUtils} from '../../lib/RootPathUtils';
import * as fs from 'graceful-fs';
import * as path from 'node:path';

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

  const exts = new Set(extensions);

  // `dirPrefix` is `directory` with a trailing separator, which only a root
  // may already have (a filesystem root, '/' or 'C:\\').
  function search(
    directory: string,
    dirPrefix: string,
    dirNormal: string,
    isWithinRoot: boolean,
  ): void {
    activeCalls++;
    fs.readdir(directory, {withFileTypes: true}, (err, entries) => {
      activeCalls--;
      if (err) {
        console.warn(
          `Error "${err.code ?? err.message}" reading contents of "${directory}", skipping. Add this directory to your ignore list to exclude it.`,
        );
      } else {
        for (const entry of entries) {
          const name = entry.name.toString();
          const file = dirPrefix + name;

          const isSymbolicLink = entry.isSymbolicLink();
          if (ignore(file) || (!includeSymlinks && isSymbolicLink)) {
            continue;
          }

          // Deriving a normal path above the root dir requires slicing off an up-fragment
          // then checking if the target matches the next segment of the root dir. It's therefore
          // easier to fall back to `pathUtils.absoluteToNormal`
          const childNormal = !isWithinRoot
            ? pathUtils.absoluteToNormal(file)
            : dirNormal === ''
              ? name
              : dirNormal + path.sep + name;

          if (entry.isDirectory()) {
            search(
              file,
              file + path.sep,
              childNormal,
              isWithinRoot || childNormal === '',
            );
            continue;
          }

          const ext = path.extname(file).substr(1);
          if (!isSymbolicLink && !exts.has(ext)) {
            continue;
          }

          activeCalls++;
          fs.lstat(file, (err, stat) => {
            activeCalls--;

            if (!err && stat) {
              result.set(childNormal, [
                stat.mtime.getTime(),
                stat.size,
                0,
                null,
                isSymbolicLink ? 1 : 0,
                null,
              ]);
            }

            if (activeCalls === 0) {
              callback(result);
            }
          });
        }
      }

      if (activeCalls === 0) {
        callback(result);
      }
    });
  }

  if (roots.length > 0) {
    for (const root of roots) {
      const rootNormal = pathUtils.absoluteToNormal(root);
      const isWithinRoot =
        rootNormal !== '..' && !rootNormal.startsWith('..' + path.sep);
      search(
        root,
        root.endsWith(path.sep) ? root : root + path.sep,
        rootNormal,
        isWithinRoot,
      );
    }
  } else {
    callback(result);
  }
}

export default async function nodeCrawl(
  options: CrawlerOptions,
): Promise<CrawlResult> {
  const {
    console,
    previousState,
    extensions,
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

  const fileData = await new Promise<FileData>(resolve => {
    find(roots, extensions, ignore, includeSymlinks, rootDir, console, resolve);
  });

  abortSignal?.throwIfAborted();

  const difference = previousState.fileSystem.getDifference(fileData, {
    subpath,
  });

  perfLogger?.point('nodeCrawl_end');
  return difference;
}
