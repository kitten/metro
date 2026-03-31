/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
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

type DirectoryNode = Map<string, MixedNode>;
type FileNode = FileMetadata;
type MixedNode = FileNode | DirectoryNode;

type FallbackFilesystemOptions = {
  extensions: ReadonlyArray<string>,
  ignore: IgnoreMatcher,
  includeSymlinks: boolean,
};

const readdirMarker = Symbol.for('fallbackDir');

function markDir(dirNode: any) {
  dirNode[readdirMarker] = true;
}

function isMarkedDir(dirNode: any) {
  return !!dirNode[readdirMarker];
}

function isDirectory(node: ?MixedNode): node is DirectoryNode {
  return node instanceof Map;
}

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

  function readdir(
    absolutePath: string,
    dirNode: ?DirectoryNode,
  ): DirectoryNode | null {
    if (dirNode != null && isMarkedDir(dirNode)) {
      return dirNode;
    }
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(absolutePath, {withFileTypes: true});
    } catch {
      return null;
    }
    const result = dirNode ?? new Map();
    for (const entry of dirEntries) {
      const name = entry.name.toString();
      const childPath = path.join(absolutePath, name);

      if (ignore(childPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        if (!result.has(name)) {
          result.set(name, new Map());
        }
      } else if (entry.isSymbolicLink()) {
        if (!includeSymlinks || result.has(name)) {
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
        if (!extensions.includes(ext) || result.has(name)) {
          continue;
        }
        result.set(name, [0, 0, 0, null, 0, null]);
      }
    }
    markDir(result);
    return result;
  }

  return {
    readdir,

    lookup(
      absolutePath: string,
      prevNode: ?MixedNode,
    ): MixedNode | null {
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
        return readdir(
          absolutePath,
          isDirectory(prevNode) ? prevNode : null,
        );
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
  };
}
