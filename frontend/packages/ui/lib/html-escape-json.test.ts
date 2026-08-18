/**
 * ★★★ THIS SUITE HAD NEVER ONCE RUN (B5, 2026-08-18).
 *
 * It was written against Jest globals — `describe`/`it`/`expect` with no import — in a
 * package that has no Jest, no Vitest, and no `test` script. `turbo.json` even defined a
 * `test:jest` task, which no package in the monorepo implements. So there was no command,
 * anywhere, that could execute this file. It was coverage on paper only.
 *
 * That matters more here than almost anywhere else in the repo: every assertion below is
 * an XSS guard. `safeJsonForScript` is what stops a post's content from breaking out of
 * an inline `<script>` tag, and the test proving it works was decorative.
 *
 * Converted to the runner this monorepo actually has (mocha + chai, the same pair
 * `packages/renderer` and `packages/transaction` use) and wired to `pnpm test` in this
 * package. Not one assertion was weakened in the move — the Jest matchers map one-to-one
 * onto chai's, and the suite passes.
 */
import { describe, it } from 'mocha';
import { expect } from 'chai';
import { safeJsonForScript, htmlEscapeJsonString } from './html-escape-json';

describe('htmlEscapeJsonString', () => {
  it('escapes < to prevent script breakout', () => {
    const result = htmlEscapeJsonString('</script>');
    expect(result).to.not.include('<');
    expect(result).to.include('\\u003c');
  });

  it('escapes > to prevent comment issues', () => {
    const result = htmlEscapeJsonString('-->');
    expect(result).to.not.include('>');
    expect(result).to.include('\\u003e');
  });

  it('escapes & to prevent HTML entity injection', () => {
    const result = htmlEscapeJsonString('foo&bar');
    expect(result).to.not.include('&');
    expect(result).to.include('\\u0026');
  });

  it('escapes line separator U+2028', () => {
    const result = htmlEscapeJsonString('line\u2028break');
    expect(result).to.include('\\u2028');
  });

  it('escapes paragraph separator U+2029', () => {
    const result = htmlEscapeJsonString('para\u2029break');
    expect(result).to.include('\\u2029');
  });

  it('leaves safe characters unchanged', () => {
    const result = htmlEscapeJsonString('hello world 123');
    expect(result).to.equal('hello world 123');
  });
});

describe('safeJsonForScript', () => {
  it('escapes < and > to prevent script breakout', () => {
    const result = safeJsonForScript('</script><script>alert(1)');
    expect(result).to.not.include('</script>');
    expect(result).to.include('\\u003c');
    expect(result).to.include('\\u003e');
  });

  it('escapes & to prevent HTML entity injection', () => {
    const result = safeJsonForScript('foo&bar');
    expect(result).to.include('\\u0026');
  });

  it('escapes line terminators', () => {
    const result = safeJsonForScript('line\u2028break');
    expect(result).to.include('\\u2028');
  });

  it('produces valid JavaScript that evaluates to original value', () => {
    const original = 'test</script>&\u2028value';
    const escaped = safeJsonForScript(original);
    // eval is safe here - we control the input
    // eslint-disable-next-line no-eval
    const evaluated = eval(escaped);
    expect(evaluated).to.equal(original);
  });

  it('handles null', () => {
    expect(safeJsonForScript(null)).to.equal('null');
  });

  it('handles objects', () => {
    const obj = { key: '<script>test</script>' };
    const result = safeJsonForScript(obj);
    expect(result).to.not.include('<script>');
    expect(result).to.include('\\u003c');
  });

  it('handles arrays', () => {
    const arr = ['<', '>', '&'];
    const result = safeJsonForScript(arr);
    expect(result).to.not.include('<');
    expect(result).to.not.include('>');
    expect(result).to.not.include('&');
  });
});
