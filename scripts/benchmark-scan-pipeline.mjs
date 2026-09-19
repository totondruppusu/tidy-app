// Run with: node scripts/benchmark-scan-pipeline.mjs
// Transpile just this pure TypeScript module using the project's existing compiler.
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { strict as assert } from "node:assert";
import ts from "typescript";

const source = await readFile(
  new URL("../src/lib/scanBatchQueue.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2020,
  },
});
const { createScanBatchQueue } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const files = Array.from({ length: 50000 }, (_, i) => ({
  id: `id${i}`,
  path: `/root/folder${i % 100}/file${i}.txt`,
  name: `file${i}.txt`,
  kind: "text",
  sizeBytes: 1024,
  modifiedMs: 1000,
  mime: "text/plain",
}));

const started = performance.now();
const payload = JSON.stringify({
  request: { folderPath: "/root", filterMode: "all" },
  result: { files, total: files.length },
});
console.log(
  JSON.stringify({
    cacheUploadBytesRemoved: Buffer.byteLength(payload),
    oldStringifyMs: performance.now() - started,
  }),
);

function legacy() {
  let accumulated = [];
  for (let i = 0; i < files.length; i += 500) {
    const seen = new Set();
    accumulated = [...accumulated, ...files.slice(i, i + 500)].filter(
      (file) => {
        const key = file.path || file.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  }
  return accumulated;
}

function incremental() {
  let accumulated = [];
  let flush;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  // Equal publication count isolates deduplication cost from timer/coalescing gains.
  globalThis.setTimeout = (callback) => {
    flush = callback;
    return 1;
  };
  globalThis.clearTimeout = () => {};
  const queue = createScanBatchQueue((batch) => {
    accumulated = accumulated.concat(batch);
  });
  try {
    for (let i = 0; i < files.length; i += 500) {
      queue.enqueue(files.slice(i, i + 500));
      flush();
    }
    queue.reset();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  return accumulated;
}

for (const [label, run] of [
  ["legacy", legacy],
  ["incremental", incremental],
]) {
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const result = run();
    samples.push(performance.now() - start);
    assert.deepEqual(result, files);
  }
  console.log(
    JSON.stringify({
      label,
      files: files.length,
      batches: 100,
      milliseconds: samples,
    }),
  );
}
