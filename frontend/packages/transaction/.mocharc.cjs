/*
 * Mocha settings for this package.
 *
 * `node-option` is added only where Node strips TypeScript itself (Node 22.18+ reports
 * `process.features.typescript`). There, mocha's first attempt, `import()` of a .ts test,
 * succeeds natively and loads the file as an ES module, so the tests' `require` throws
 * "require is not defined in ES module scope" before ts-node is ever asked. Turning the
 * native stripping off sends every file back through ts-node, as on Node 20. Node 20
 * (CI pins 20.11) has no such flag and would reject it, so there it is left out.
 */
const nativeTypeScript = Boolean(process.features && process.features.typescript);

module.exports = {
  recursive: true,
  require: ['ts-node/register'],
  ...(nativeTypeScript ? { 'node-option': ['no-experimental-strip-types'] } : {})
};
