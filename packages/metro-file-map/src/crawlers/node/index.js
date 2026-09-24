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
  FileSystem,
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
  previousFileSystem: FileSystem | null,
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

          const isSymlink = entry.isSymbolicLink();
          if (isSymlink && !includeSymlinks) {
            return;
          }

          if (entry.isDirectory()) {
            search(file);
            return;
          }

          const ext = path.extname(file).substr(1);
          if (!isSymlink && !extensions.includes(ext)) {
            return;
          }

          const fileNormal = pathUtils.absoluteToNormal(file);
          const mtime = previousFileSystem?.getMtimeByNormalPath(fileNormal);
          if (mtime == null || mtime === 0) {
            // When we're in a cold start or a previous file doesn't exist, we can skip
            // the mtime/size lstat now and treat the file as new
            result.set(fileNormal, [null, 0, 0, null, isSymlink ? 1 : 0, null]);
          } else {
            activeCalls++;
            fs.lstat(file, (err, stat) => {
              activeCalls--;

              if (!err && stat) {
                result.set(fileNormal, [
                  stat.mtime.getTime(),
                  stat.size,
                  0,
                  null,
                  isSymlink ? 1 : 0,
                  null,
                ]);
              }

              if (activeCalls === 0) {
                callback(result);
              }
            });
          }
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

  return new Promise((resolve, reject) => {
    const callback: Callback = fileData => {
      const difference = previousState.fileSystem.getDifference(fileData, {
        subpath,
      });

      perfLogger?.point('nodeCrawl_end');

      try {
        // TODO: Use AbortSignal.reason directly when Flow supports it
        abortSignal?.throwIfAborted();
      } catch (e) {
        reject(e);
      }
      resolve(difference);
    };

    find(
      roots,
      extensions,
      ignore,
      includeSymlinks,
      rootDir,
      console,
      previousState.fileSystem,
      callback,
    );
  });
}
