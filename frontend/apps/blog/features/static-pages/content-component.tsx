import { Remarkable } from 'remarkable';
import path from 'path';
import fs from 'fs';

/**
 * CONTAINMENT ON THE `filename` PROP (2026-08-23).
 *
 * This did `fs.readFileSync(path.join('lib', 'markdowns', filename))` inside a SERVER
 * component with the prop unchecked. Both current callers pass a hardcoded literal
 * (`help.html/page.tsx`, `tos.html/page.tsx`), so nothing is exploitable today, but the
 * base directory sits two hops from a live `.env` carrying a posting key, the DB URL and
 * the cookie-sealing secret. "Safe because every caller happens to be careful" is exactly
 * the shape this codebase keeps getting caught by.
 *
 * Two independent guards, because either alone is weaker than it looks:
 *   1. SHAPE - a bare `name.md`. Rejects separators, `..`, absolute paths and NUL, so
 *      nothing traversal-shaped ever reaches `path.join`.
 *   2. CONTAINMENT - resolve the joined path and require it to still sit under the
 *      markdowns directory. This one cannot be argued around, and it holds even if the
 *      shape rule is later loosened.
 *
 * Fails CLOSED and loudly: a bad name throws rather than reading an arbitrary file.
 */
const MARKDOWN_DIR = path.join('lib', 'markdowns');
const SAFE_FILENAME = /^[A-Za-z0-9._-]+\.md$/;

function readStaticMarkdown(filename: string): string {
  if (!SAFE_FILENAME.test(filename)) {
    throw new Error('StaticContent: refusing unsafe filename');
  }
  const filePath = path.join(MARKDOWN_DIR, filename);
  const root = path.resolve(MARKDOWN_DIR);
  if (path.resolve(filePath) !== path.join(root, filename)) {
    throw new Error('StaticContent: filename escapes the markdown directory');
  }
  return fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
}

const StaticContent = ({ filename }: { filename: string }) => {
  const data = readStaticMarkdown(filename);
  const renderer = new Remarkable({
    html: true,
    xhtmlOut: true,
    typographer: false,
    quotes: '“”‘’'
  });
  const content = renderer.render(data);
  return (
    <>
      <div className="mx-auto my-12 max-w-3xl px-4">
        <div
          id="articleBody"
          className="prose"
          dangerouslySetInnerHTML={{
            __html: content
          }}
        />
      </div>
    </>
  );
};

export default StaticContent;
