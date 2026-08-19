import { getRenderer, getPreviewRenderer } from '@/blog/features/post-rendering/lib/renderer';
import { Signer } from '@smart-signer/lib/signer/signer';
import { configuredImagesEndpoint } from '@ui/config/public-vars';
import { handleError } from '@ui/lib/handle-error';
import { getLogger } from '@ui/lib/logging';
import { isCommunity } from '@ui/lib/utils';
import { TFunction } from 'i18next';
import { Dispatch, SetStateAction } from 'react';
import { uploadLiteImage } from '@/blog/lib/lite/client/lite-profile';
import { processImageForUpload } from './image-processing';
import type { BatchFileItem, FileProcessingStatus, ProcessingOptions } from './image-processing-types';
import {
  TAGS_REQUIRED,
  IMAGE_UPLOAD_KEYCHAIN_MISSING,
  IMAGE_UPLOAD_KEYCHAIN_DECLINED,
  IMAGE_UPLOAD_ACCOUNT_NOT_READY,
  IMAGE_UPLOAD_FAILED_RETRY
} from './composer-copy';

const logger = getLogger('app');

export const MAX_TAGS = 8;
/**
 * Normalizes a raw tag input string by replacing commas with spaces
 * and collapsing multiple spaces into one.
 */
export function normalizeTagInput(value: string): string {
  return value.replace(/,/g, ' ').replace(/ {2,}/g, ' ');
}

/**
 * Parses a normalized tag string into an array of non-empty tags.
 */
export function parseTags(value: string): string[] {
  return normalizeTagInput(value)
    .trim()
    .replace(/#/g, '')
    .split(/ +/)
    .filter(Boolean);
}

export function validateTagInput(value: string, required: boolean, t: TFunction<'common_blog', undefined>) {
  // ★ C-2: `submit_page.category_selector.required` reads "Required when post to
  // My Blog", which is not a sentence. See lib/composer-copy.ts for why the
  // replacement is a constant rather than a new key in nine locale files.
  if (!value || value.trim() === '') return required ? TAGS_REQUIRED : null;
  const tags = parseTags(value);
  return tags.length > MAX_TAGS
    ? t('submit_page.category_selector.use_limited_amount_of_categories', {
        amount: MAX_TAGS
      })
    : tags.find((c) => c.length > 24)
      ? t('submit_page.category_selector.maximum_tag_length_is_24_characters')
      : tags.find((c) => c.split('-').length > 2)
        ? t('submit_page.category_selector.use_one_dash')
        : tags.find((c) => /[A-Z]/.test(c))
          ? t('submit_page.category_selector.use_only_lowercase_letters')
          : tags.find((c) => !/^[a-z0-9-#]+$/.test(c))
            ? t('submit_page.category_selector.use_only_allowed_characters')
            : tags.find((c) => !/^[a-z-#]/.test(c))
              ? t('submit_page.category_selector.must_start_with_a_letter')
              : tags.find((c) => !/[a-z0-9]$/.test(c))
                ? t('submit_page.category_selector.must_end_with_a_letter_or_number')
                : tags.filter((c) => isCommunity(c)).length > 0
                  ? t('submit_page.category_selector.must_not_include_hivemind_community_owner')
                  : tags.reduce((acc, tag, index, array) => {
                        const isDuplicate = array.slice(index + 1).some((b) => b === tag);
                        return acc || isDuplicate;
                      }, false)
                    ? t('submit_page.category_selector.tags_cannot_be_repeated')
                    : null;
}

export function validateSummaryInput(value: string, t: TFunction<'common_wallet', undefined>) {
  const markdownRegex = /(?:\*[\w\s]*\*|#[\w\s]*#|_[\w\s]*_|~[\w\s]*~|\]\s*\(|\]\s*\[)/;
  const htmlTagRegex = /<\/?[\w\s="/.':;#-/?]+>/gi;
  return markdownRegex.test(value)
    ? t('submit_page.markdown_not_supported')
    : htmlTagRegex.test(value)
      ? t('submit_page.html_not_supported')
      : null;
}

export function validateAltUsernameInput(value: string, t: TFunction<'common_wallet', undefined>) {
  const altAuthorAllowedCharactersRegex = /^[\w.\d-]+$/;
  return value !== '' && !altAuthorAllowedCharactersRegex.test(value)
    ? t('submit_page.must_contain_only')
    : null;
}
export function imagePicker(img: string) {
  const checkImg = img.startsWith('youtu-') ? `https://img.youtube.com/vi/${img.slice(6)}/0.jpg` : img;
  return checkImg;
}

/**
 * Finds all images in markdown content, so also in html content, and
 * returns their `src` attribute.
 *
 * @export
 * @param {string} markdownContent
 * @return {*}  {string[]}
 */
export function extractImagesSrc(markdownContent: string, proxyAuthToken?: string): string[] {
  if (markdownContent === '') return [];
  const parser = new DOMParser();
  const renderer = proxyAuthToken ? getPreviewRenderer(proxyAuthToken) : getRenderer('');
  const doc = parser.parseFromString(renderer.render(markdownContent), 'text/html');
  const images = doc.getElementsByTagName('img');
  const result = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    // Skip images inside YouTube facade - these are auto-generated thumbnails
    // User-explicitly added YouTube thumbnail images (standalone) are still included
    if (img.closest('.youtube-facade')) continue;
    result.push(img.src);
  }
  return result;
}

export function maxAcceptedPayout(customValue: number | string | undefined, maxPayout: string) {
  switch (maxPayout) {
    case 'no_max':
      return 1000000;
    case '0':
      return 0;
    case 'custom':
      return customValue === '0' ? 1000000 : Number(customValue);
  }
  return 1000000;
}

/**
 * ★ WHICH FAILURE THIS WAS, NOT JUST THAT IT FAILED (2026-08-14). This used to
 * be `handleError(error)` with no `toastOptions`, so every upload failure —
 * Keychain locked, Keychain missing, no signer yet, a dead network — fell
 * through to `transformError`'s generic guesswork and, most of the time,
 * landed on "try again". That is wrong advice for a locked Keychain: signing
 * will fail the same way on the next attempt too, until the user acts on
 * Keychain itself. See the long comment above the constants this returns, in
 * `./composer-copy.ts`, for exactly what is and is not distinguishable here
 * and why.
 */
function classifyUploadFailure(error: unknown, signer: Signer): string {
  // `!signer` covers two different real causes — a genuinely keyless lite
  // account whose `/api/lite/upload` session the server just rejected, or a
  // full account caught in the brief window before `SignerProvider` finishes
  // building its signer object (packages/smart-signer/components/
  // signer-provider.tsx: `signer` starts `null`, set later from an async
  // dynamic import). Neither is a Keychain question, so this never guesses
  // "locked" for it.
  if (!signer) return IMAGE_UPLOAD_ACCOUNT_NOT_READY;

  const message = error instanceof Error ? error.message : '';
  if (message === 'Keychain is not installed') return IMAGE_UPLOAD_KEYCHAIN_MISSING;
  if (message.startsWith('Keychain error: ')) return IMAGE_UPLOAD_KEYCHAIN_DECLINED;

  return IMAGE_UPLOAD_FAILED_RETRY;
}

/**
 * Uploads image to Imagehoster, see
 * https://gitlab.syncad.com/hive/imagehoster. Function returns url to
 * image on server or empty string in case of any error.
 *
 * @param {File} file
 * @param {string} username
 * @param {Signer} signer
 * @returns {Promise<string>}
 */
export const uploadImg = async (file: File, username: string, signer: Signer): Promise<string> => {
  try {
    if (!file)
      throw new Error("No file provided");

    // Keyless (Lumen lite) account: there is no signer to sign the upload challenge
    // with — `SignerProvider` deliberately leaves it null for this tier — so the file
    // goes to /api/lite/upload, which signs it server-side with the publishing
    // account. Checked here rather than at each call site so every entry point
    // (toolbar, drag-drop, paste, profile pictures) is covered by one branch.
    if (!signer) return await uploadLiteImage(file);

    const fileData = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        // reader.result is an ArrayBuffer; convert to Uint8Array immediately
        resolve(new Uint8Array(reader.result as ArrayBuffer));
      });
      reader.readAsArrayBuffer(file);
    });

    const formData = new FormData();
    formData.append('file', file);

    // 3. Create prefix using TextEncoder (Native alternative to Buffer.from)
    const encoder = new TextEncoder();
    const prefix = encoder.encode('ImageSigningChallenge');

    // 4. Standardized Concatenation
    // Create a container of the total size
    const buf = new Uint8Array(prefix.length + fileData.length);

    // Copy prefix to the start, and fileData right after it
    buf.set(prefix, 0);
    buf.set(fileData, prefix.length);

    const sig = await signer.signChallenge({
      message: buf,
      password: ''
    });

    const imageOwner = signer.authorityUsername || signer.username;

    const postUrl = `${configuredImagesEndpoint}/${imageOwner}/${sig}`;

    const response = await fetch(postUrl, { method: 'POST', body: formData });
    const resJSON = await response.json();
    return resJSON.url;
  } catch (error) {
    logger.error('Error when uploading file %s: %o', file.name, error);
    handleError(error, undefined, { description: classifyUploadFailure(error, signer) });
  }
  return '';
};

export const onImageUpload = async (
  file: File,
  insertText: (text: string, pos?: number) => void,
  username: string,
  signer: Signer,
  setUploading?: Dispatch<SetStateAction<boolean>>,
  cursorPos?: number,
  processingOptions?: ProcessingOptions
) => {
  setUploading?.(true);
  try {
    const result = await processImageForUpload(file, processingOptions);
    const url = await uploadImg(result.file, username, signer);
    const name = result.file.name;
    const imageMarkdown = ` ![${name}](${!url ? 'UPLOAD FAILED' : url}) `;
    insertText(imageMarkdown, cursorPos);
  } catch (error) {
    logger.error('Image processing/upload failed for %s: %o', file.name, error);
    handleError(error);
    insertText(` ![${file.name}](UPLOAD FAILED) `, cursorPos);
  }
  setUploading?.(false);
};

export const onImageDrop = async (
  dataTransfer: DataTransfer,
  insertText: (text: string, pos?: number) => void,
  username: string,
  signer: Signer,
  setUploading?: Dispatch<SetStateAction<boolean>>,
  cursorPos?: number,
  processingOptions?: ProcessingOptions
) => {
  const files: File[] = [];
  for (let index = 0; index < dataTransfer.items.length; index++) {
    const file = dataTransfer.files.item(index);
    if (file) files.push(file);
  }

  if (files.length === 1) {
    await onImageUpload(files[0], insertText, username, signer, setUploading, cursorPos, processingOptions);
    return;
  }

  // Multiple files: block format with empty lines, sequential for mobile memory
  setUploading?.(true);
  let insertOffset = 0;
  for (const file of files) {
    try {
      const result = await processImageForUpload(file, processingOptions);
      const url = await uploadImg(result.file, username, signer);
      const name = result.file.name;
      const markdown = `![${name}](${!url ? 'UPLOAD FAILED' : url})\n\n`;
      const adjustedPos = cursorPos !== undefined ? cursorPos + insertOffset : undefined;
      insertText(markdown, adjustedPos);
      insertOffset += markdown.length;
    } catch (error) {
      logger.error('Image processing/upload failed for %s: %o', file.name, error);
      handleError(error);
      const markdown = `![${file.name}](UPLOAD FAILED)\n\n`;
      const adjustedPos = cursorPos !== undefined ? cursorPos + insertOffset : undefined;
      insertText(markdown, adjustedPos);
      insertOffset += markdown.length;
    }
  }
  setUploading?.(false);
};

export const onImagePaste = async (
  clipboardData: DataTransfer,
  insertText: (text: string, pos?: number) => void,
  username: string,
  signer: Signer,
  setUploading?: Dispatch<SetStateAction<boolean>>,
  cursorPos?: number,
  processingOptions?: ProcessingOptions
) => {
  const files: File[] = [];
  for (let i = 0; i < clipboardData.items.length; i++) {
    const item = clipboardData.items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (!files.length) return false;

  if (files.length === 1) {
    await onImageUpload(files[0], insertText, username, signer, setUploading, cursorPos, processingOptions);
    return true;
  }

  // Multiple files: block format with empty lines, sequential for mobile memory
  setUploading?.(true);
  let insertOffset = 0;
  for (const file of files) {
    try {
      const result = await processImageForUpload(file, processingOptions);
      const url = await uploadImg(result.file, username, signer);
      const name = result.file.name;
      const markdown = `![${name}](${!url ? 'UPLOAD FAILED' : url})\n\n`;
      const adjustedPos = cursorPos !== undefined ? cursorPos + insertOffset : undefined;
      insertText(markdown, adjustedPos);
      insertOffset += markdown.length;
    } catch (error) {
      logger.error('Image processing/upload failed for %s: %o', file.name, error);
      handleError(error);
      const markdown = `![${file.name}](UPLOAD FAILED)\n\n`;
      const adjustedPos = cursorPos !== undefined ? cursorPos + insertOffset : undefined;
      insertText(markdown, adjustedPos);
      insertOffset += markdown.length;
    }
  }
  setUploading?.(false);
  return true;
};

// insertToTextArea removed - caused #672 by DOM manipulation instead of React state

export interface BatchUploadCallbacks {
  onFileStart: (index: number, file: File) => void;
  onFileProgress: (index: number, status: FileProcessingStatus) => void;
  onFileComplete: (index: number, url: string, name: string) => void;
  onFileError: (index: number, error: string) => void;
  onAllComplete: () => void;
}

export const onBatchImageUpload = async (
  files: File[],
  insertText: (text: string, pos?: number) => void,
  username: string,
  signer: Signer,
  callbacks: BatchUploadCallbacks,
  cursorPos?: number,
  processingOptions?: ProcessingOptions
) => {
  let insertOffset = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    callbacks.onFileStart(i, file);
    try {
      callbacks.onFileProgress(i, 'processing');
      const result = await processImageForUpload(file, processingOptions);

      callbacks.onFileProgress(i, 'uploading');
      const url = await uploadImg(result.file, username, signer);
      const name = result.file.name;

      if (url) {
        const markdown = `![${name}](${url})\n\n`;
        const adjustedPos = cursorPos !== undefined ? cursorPos + insertOffset : undefined;
        insertText(markdown, adjustedPos);
        insertOffset += markdown.length;
        callbacks.onFileComplete(i, url, name);
      } else {
        callbacks.onFileError(i, 'Upload returned empty URL');
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      callbacks.onFileError(i, msg);
      logger.error('Batch upload file %d (%s) failed: %o', i, file.name, error);
    }
  }
  callbacks.onAllComplete();
};

export type { BatchFileItem, FileProcessingStatus, ProcessingOptions };

// ★ WAS `font-source` (2026-08-11, audit item 6). That utility has ZERO
// generated CSS: Tailwind's content glob only scans `**/*.{jsx,tsx}` (see
// `packages/tailwindcss/tailwind.config.js`), and this string lives in a
// plain `.ts` file, so the class name is invisible to the JIT scanner and
// compiles to nothing. The post body silently fell back to the inherited
// `font-sans` (Open Sans) on `<body>`, while every feed/profile excerpt of
// the same prose (e.g. `medium-post-card.tsx`, `profile-identity.tsx`) uses
// the working `font-serif` utility and renders Lora. `font-serif` already
// resolves to the exact same variable (see `apps/blog/tailwind.config.js`,
// where it is now called `--font-lora`; this note said `--font-serif`, one rename
// behind, until 2026-08-19) that `font-source` was meant to alias,
// so swapping to it is a same-font, zero-behavior-change fix that makes post
// bodies match excerpts instead of a rename that would need a new dead alias
// chased down again later. (2026-08-13: `font-sanspro`, mentioned by the
// previous version of this note, has since been deleted outright — it was a
// byte-identical duplicate of `font-sans`; its real call sites, including this
// page's title, now say `font-sans`.)
//
// ★★★ THE RESPONSIVE AND HEADING RAMP THAT USED TO BE HERE NEVER RENDERED
// (2026-08-13, typography audit item 1). This file is a `.ts`, and the Tailwind
// content glob was `**/*.{jsx,tsx}` (see `packages/tailwindcss/tailwind.config.js`),
// so the JIT scanner never read this string. MEASURED on the shipped build:
// `26.4px`, `23.1px`, `19.8px`, `18.1px`, `17.6px`, `19.2px`, `30.7px`, `28.9px`
// and `21.1px` each appear ZERO times in `/_next/static/css/*.css`. `16.5px`
// appeared exactly once — and only because `medium-post-card.tsx` and
// `profile-identity.tsx` (both `.tsx`) happened to use the same value for feed
// excerpts. Net effect on a real post at a 1534px viewport: the body was
// 16.5px at EVERY breakpoint, `prose-p:mb-6` did nothing, and every heading fell
// back to the typography plugin's em ramp off the 16.5px container —
// h1 2.25em = 37.125px, h2 24.75px, h3 20.625px, h4 16.5px, all fractional, all
// on fractional line boxes. `apps/blog/tailwind.config.js` now also scans `.ts`,
// so from here on this string is real and must be read as such.
//
// Sizes are whole pixels paired with whole-pixel line-heights so a post body
// lands on the device pixel grid: the app inherits Tailwind Preflight's
// `:host,html{line-height:1.5}` — a UNITLESS ratio — and `prose` overrides it
// with `1.75`, so ANY container size that is not a multiple of 4 produced a
// fractional line box and pushed every following block off the grid.
//
// Values are the previous RENDERED geometry rounded to whole pixels, not a new
// scale: body 16.5/28.875 -> 17/28 (also audit item 6's "17-18px, ~1.6
// leading"), h1 37.125/41.25 -> 36/40, h2 24.75/33 -> 25/32, h3 20.625/33 ->
// 21/32, h4 16.5/24.75 -> 17/24. The dead ramp's own numbers (h1 26.4px) are
// deliberately NOT revived — switching post h1 from a rendered 37px to 26px is a
// redesign, not a rounding, and nobody has asked for one. Paragraph rhythm was a
// collapsed 20.625px; `prose-p:my-5` is 20px (audit item 8: whole-pixel prose
// margins).
// 2026-08-17: `prose-img:max-h-[70vh] prose-img:object-contain` added. Article
// bodies had no cap at all on image height, unlike comments (audit found
// comments cap at 400px) — so a tall photo post (a portrait screenshot, a
// full-length photo) could run to its native height and dominate the
// viewport, pushing all following text off-screen. `object-contain` alongside
// the cap keeps `max-w-full` intact (an image can still be capped by width or
// height, whichever binds first) rather than cropping or distorting it.
// ★★★ THE ARTICLE BODY, ALL-LORA (2026-08-19, typography spec §5.4).
//
// `text-read` is 18px/30px — the ladder's reading step, and an ~8% bump on the
// old 17/28. That is not a taste change: Lora's x-height measures 0.926 of Open
// Sans's, so the same pixel value renders visibly smaller in the new face and
// running text is where a reader notices it first. The leading rises with it
// because a serif's longer extenders need more room than a sans at the same size.
//
// `max-w-[68ch]` is new and is a MEASURE, not a width. `.prose`'s own max-width
// is already overridden to 100% in the shared config, and the outer container
// caps at 896px — neither of which is expressed in characters, so the line length
// drifted with the viewport. 68 characters is the spec's value and the one number
// here that is about reading rather than rendering.
//
// `prose-h2:tracking-title` (-0.01em): H2 is 26px, big enough for a serif's
// bracketed serifs to collide at the sans-tuned default. H3 goes 22 -> 21 per the
// spec; 21 has no rung on either ladder, so it stays an arbitrary value rather
// than being rounded onto one it does not belong to.
//
// H1 and H4 are deliberately UNCHANGED: §5.4 gives no target for them, and
// inventing one to make the string look uniform is how a spec quietly becomes
// something nobody agreed to.
//
// Blockquote needs no entry here. It carries no explicit font-size anywhere, so
// it inherits 1em of this container and follows the bump automatically; its
// italic comes from the typography plugin's own default, which §4 wants.
export const postClassName =
  'font-lora text-read max-w-[68ch] prose-p:my-5 prose-h1:text-[34px] prose-h1:leading-[40px] prose-h2:text-[26px] prose-h2:leading-[32px] prose-h2:tracking-title prose-h3:text-[21px] prose-h3:leading-[32px] prose-h4:text-[17px] prose-h4:leading-[24px] prose-img:cursor-pointer prose-img:max-w-full prose-img:h-auto prose-img:max-h-[70vh] prose-img:object-contain';
