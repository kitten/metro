#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Benchmark: Native find binary crawler vs Node.js readdir crawler.
 *
 * The native find binary approach has three compounding costs:
 *
 *   1. Process spawn overhead — fork() + exec() to launch /usr/bin/find.
 *   2. Serialized phases — find must complete its entire traversal and write
 *      all paths to stdout before Node can parse them and begin lstat calls.
 *      The readdir crawler starts lstat calls immediately as each directory
 *      yields entries, keeping the kernel I/O queue saturated throughout.
 *   3. String serialization — all file paths are serialized to text by find,
 *      buffered through a pipe, then deserialized by splitting on newlines.
 *      The readdir approach works with in-process Dirent objects directly.
 *
 * Run:
 *   node packages/metro-file-map/src/crawlers/node/__tests__/bench-find-vs-readdir.js
 *
 * @format
 * @oncall react_native
 */

'use strict';

const {spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const ITERATIONS = 7;
const ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');
const EXTENSIONS = ['js', 'ts', 'json'];
const IGNORE = p => /node_modules|__generated__|\.git/.test(p);

// ── Node readdir crawler (current implementation) ────────────────────────────

function crawlReaddir(roots, extensions, ignore, callback) {
  const result = [];
  let activeCalls = 0;

  function search(directory) {
    activeCalls++;
    fs.readdir(directory, {withFileTypes: true}, (err, entries) => {
      activeCalls--;
      if (err) {
        // skip
      } else {
        for (const entry of entries) {
          const file = path.join(directory, entry.name.toString());
          if (ignore(file)) continue;
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            search(file);
            continue;
          }
          activeCalls++;
          fs.lstat(file, (err, stat) => {
            activeCalls--;
            if (!err && stat) {
              const ext = path.extname(file).slice(1);
              if (extensions.includes(ext)) {
                result.push([file, stat.mtime.getTime(), stat.size]);
              }
            }
            if (activeCalls === 0) callback(result);
          });
        }
      }
      if (activeCalls === 0) callback(result);
    });
  }

  if (roots.length > 0) {
    roots.forEach(search);
  } else {
    callback(result);
  }
}

// ── Native find binary crawler (removed implementation) ──────────────────────

function crawlFindBinary(roots, extensions, ignore, callback) {
  const extensionClause = extensions.length
    ? `( ${extensions.map(ext => `-iname *.${ext}`).join(' -o ')} )`
    : '';
  const expression = `( ( -type f ${extensionClause} ) )`;

  const child = spawn('find', roots.concat(expression.split(' ')));
  let stdout = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', data => (stdout += data));

  child.stdout.on('close', () => {
    const lines = stdout
      .trim()
      .split('\n')
      .filter(x => !ignore(x));
    const result = [];
    let count = lines.length;
    if (!count) {
      callback([]);
    } else {
      lines.forEach(filePath => {
        fs.lstat(filePath, (err, stat) => {
          if (!err && stat) {
            result.push([filePath, stat.mtime.getTime(), stat.size]);
          }
          if (--count === 0) callback(result);
        });
      });
    }
  });
}

// ── Native find binary with phase timing ─────────────────────────────────────

function crawlFindBinaryPhased(roots, extensions, ignore, callback) {
  const extensionClause = extensions.length
    ? `( ${extensions.map(ext => `-iname *.${ext}`).join(' -o ')} )`
    : '';
  const expression = `( ( -type f ${extensionClause} ) )`;

  const start = process.hrtime.bigint();
  const child = spawn('find', roots.concat(expression.split(' ')));
  let stdout = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', data => (stdout += data));

  child.stdout.on('close', () => {
    const afterFind = process.hrtime.bigint();
    const findPhaseMs = Number(afterFind - start) / 1e6;

    const lines = stdout
      .trim()
      .split('\n')
      .filter(x => !ignore(x));
    let count = lines.length;
    if (!count) {
      callback([], {findPhaseMs, lstatPhaseMs: 0});
      return;
    }

    const result = [];
    const beforeLstat = process.hrtime.bigint();
    lines.forEach(filePath => {
      fs.lstat(filePath, (err, stat) => {
        if (!err && stat) result.push(filePath);
        if (--count === 0) {
          const lstatPhaseMs =
            Number(process.hrtime.bigint() - beforeLstat) / 1e6;
          callback(result, {findPhaseMs, lstatPhaseMs});
        }
      });
    });
  });
}

// ── Harness ──────────────────────────────────────────────────────────────────

function timeOnce(crawlFn, roots) {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    crawlFn(roots, EXTENSIONS, IGNORE, result => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({ms, files: result.length});
    });
  });
}

function timeOncePhased(roots) {
  return new Promise(resolve => {
    crawlFindBinaryPhased(roots, EXTENSIONS, IGNORE, (result, phases) => {
      resolve({files: result.length, ...phases});
    });
  });
}

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function run(label, crawlFn, roots) {
  // Warmup
  await timeOnce(crawlFn, roots);

  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const {ms} = await timeOnce(crawlFn, roots);
    times.push(ms);
  }
  return {label, median: median(times), runs: times};
}

async function main() {
  const roots = [path.join(ROOT, 'packages')];

  // Count files
  const {files} = await timeOnce(crawlReaddir, roots);
  console.log(`\nCrawling ${files} files under packages/\n`);
  console.log(`${ITERATIONS} iterations + 1 warmup each\n`);
  console.log('─'.repeat(66));

  // ── Part 1: Head-to-head ───────────────────────────────────────────────
  const nodeResult = await run('Node readdir', crawlReaddir, roots);
  const nativeResult = await run('Native find binary', crawlFindBinary, roots);

  console.log('');
  for (const r of [nodeResult, nativeResult]) {
    console.log(`  ${r.label}:`);
    console.log(
      `    median: ${r.median.toFixed(1)}ms   runs: [${r.runs.map(t => t.toFixed(1)).join(', ')}]`,
    );
  }

  const speedup = nativeResult.median / nodeResult.median;
  console.log(`\n  → Node readdir is ${speedup.toFixed(1)}x faster (median)`);

  // ── Part 2: Phase breakdown ────────────────────────────────────────────
  console.log('\n' + '─'.repeat(66));
  console.log('\n  Phase breakdown of native find binary:\n');

  // Warmup
  await timeOncePhased(roots);

  const findPhases = [];
  const lstatPhases = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const {findPhaseMs, lstatPhaseMs} = await timeOncePhased(roots);
    findPhases.push(findPhaseMs);
    lstatPhases.push(lstatPhaseMs);
  }

  const medFind = median(findPhases);
  const medLstat = median(lstatPhases);
  const medNode = nodeResult.median;

  console.log(`    Phase 1 (spawn + find traversal): ${medFind.toFixed(1)}ms`);
  console.log(`    Phase 2 (lstat all files):        ${medLstat.toFixed(1)}ms`);
  console.log(`    Total:                            ${(medFind + medLstat).toFixed(1)}ms`);
  console.log('');
  console.log(`    Node readdir total (interleaved): ${medNode.toFixed(1)}ms`);
  console.log('');
  console.log(
    `    The spawn+find phase alone (${medFind.toFixed(1)}ms) already exceeds the`,
  );
  console.log(
    `    entire readdir crawl (${medNode.toFixed(1)}ms) by ${((medFind / medNode - 1) * 100).toFixed(0)}%.`,
  );
  console.log('');

  // ── Timeline diagram ──────────────────────────────────────────────────
  console.log('─'.repeat(66));
  console.log('');
  console.log('  Native find binary (two serial phases):');
  console.log('    [===spawn + find===][===lstat===]');
  console.log('    ^ no lstats until find exits');
  console.log('');
  console.log('  Node readdir (interleaved I/O):');
  console.log('    [readdir][lstat][readdir][lstat]...');
  console.log('             ^ lstats start immediately, no process spawn');
  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
