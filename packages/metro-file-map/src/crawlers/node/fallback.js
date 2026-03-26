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
  FallbackFilesystem,
  FileMetadata,
  IgnoreMatcher,
} from '../../flow-types';

import * as fs from 'graceful-fs';
import * as path from 'path';

type FallbackFilesystemOptions = {
  extensions: ReadonlyArray<string>,
  ignore: IgnoreMatcher,
  includeSymlinks: boolean,
};

/**
 * Create a FallbackFilesystem that synchronously queries the real filesystem.
 *
 * - `lookup` uses lstatSync to check a single path (for traversal).
 * - `readdir` uses readdirSync to list directory contents (for enumeration).
 *
 * Both methods apply the same filtering as the node crawler: ignore patterns,
 * extension filtering, and symlink inclusion.
 */
export default function createFallbackFilesystem(
  opts: FallbackFilesystemOptions,
): FallbackFilesystem {
  const {extensions, ignore, includeSymlinks} = opts;

  return {
    lookup(absolutePath: string): 'd' | FileMetadata | null {
      if (ignore(absolutePath)) {
        return null;
      }

      let stat;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch {
        return null;
      }

      if (stat.isDirectory()) {
        return 'd';
      }

      if (stat.isSymbolicLink()) {
        if (!includeSymlinks) {
          return null;
        }
        try {
          const target = fs.readlinkSync(absolutePath);
          return [stat.mtime.getTime(), stat.size, 0, null, target, null];
        } catch {
          return null;
        }
      }

      if (stat.isFile()) {
        // Check extension — symlinks bypass this check (same as node crawler)
        const ext = path.extname(absolutePath).slice(1);
        if (!extensions.includes(ext)) {
          return null;
        }
        return [stat.mtime.getTime(), stat.size, 0, null, 0, null];
      }

      return null;
    },

    readdir(absolutePath: string): ?Map<string, FileMetadata | 'd'> {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(absolutePath, {withFileTypes: true});
      } catch {
        return null;
      }
      const result: Map<string, FileMetadata | 'd'> = new Map();
      for (const entry of dirEntries) {
        const name = entry.name.toString();
        const childPath = path.join(absolutePath, name);

        if (ignore(childPath)) {
          continue;
        }

        if (entry.isDirectory()) {
          result.set(name, 'd');
        } else if (entry.isSymbolicLink()) {
          if (!includeSymlinks) {
            continue;
          }
          try {
            const target = fs.readlinkSync(childPath);
            result.set(name, [0, 0, 0, null, target, null]);
          } catch {
            // Can't read symlink target — skip
          }
        } else if (entry.isFile()) {
          const ext = path.extname(name).slice(1);
          if (!extensions.includes(ext)) {
            continue;
          }
          result.set(name, [0, 0, 0, null, 0, null]);
        }
      }
      return result;
    },
  };
}
