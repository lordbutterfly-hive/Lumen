/**
 * This file is based on https://github.com/openhive-network/condenser/blob/master/src/app/utils/SanitizeConfig.js
 */
import ow from 'ow';
import sanitize from 'sanitize-html';
import {Log} from '../../../Log';
import {Localization, LocalizationOptions} from '../Localization';
import {StaticConfig} from '../StaticConfig';

export class TagTransformingSanitizer {
    private options: TagsSanitizerOptions;
    private localization: LocalizationOptions;
    private sanitizationErrors: string[] = [];
    private currentPostContext?: PostContext;

    public constructor(options: TagsSanitizerOptions, localization: LocalizationOptions) {
        this.validate(options);
        Localization.validate(localization);

        this.localization = localization;
        this.options = options;
    }

    /**
     * Sanitizes HTML content by removing unsafe tags and attributes while transforming allowed tags according to configuration.
     * Uses the sanitize-html library with custom configuration for tag transformation.
     *
     * @param text - The HTML content to sanitize
     * @param postContext - Optional context about the post being rendered (for logging)
     * @returns A sanitized version of the HTML content with transformed tags and removed unsafe content
     */
    public sanitize(text: string, postContext?: PostContext): string {
        this.currentPostContext = postContext;
        return sanitize(text, this.generateSanitizeConfig());
    }

    private formatPostContext(): string {
        if (!this.currentPostContext) return '';
        const { author, permlink } = this.currentPostContext;
        if (author && permlink) return ` in @${author}/${permlink}`;
        if (author) return ` by @${author}`;
        return '';
    }

    public getErrors(): string[] {
        return this.sanitizationErrors;
    }

    /**
     * Generates configuration for the sanitize-html library.
     *
     * @returns Configuration object for sanitize-html containing:
     * - Allowed HTML tags
     * - Allowed attributes for specific tags
     * - Allowed URL schemes
     * - Tag transformation rules for iframe, img, div, td, th, and a tags
     *
     * The configuration ensures:
     * - iframes are only allowed from whitelisted sources
     * - images are properly handled based on noImage setting
     * - div classes are restricted to a whitelist
     * - table cell alignment is preserved when valid
     * - links are processed for safety with optional nofollow and target attributes
     */
    private generateSanitizeConfig(): sanitize.IOptions {
        return {
            allowedTags: StaticConfig.sanitization.allowedTags,

            // SEE https://www.owasp.org/index.php/XSS_Filter_Evasion_Cheat_Sheet
            allowedAttributes: {
                // "src" MUST pass a whitelist (below)
                iframe: ['src', 'width', 'height', 'frameborder', 'allowfullscreen', 'webkitallowfullscreen', 'mozallowfullscreen', 'sandbox', 'allow'],

                // class attribute is strictly whitelisted (below)
                // and title is only set in the case of a phishing warning
                div: ['class', 'title'],

                // style is subject to attack, filtering more below
                td: ['style'],
                th: ['style'],
                // 2026-08-17: width/height added so an <img> written directly as raw HTML in a
                // post (Remarkable has `html: true`, so raw tags pass through renderMarkdown
                // untouched) can keep its intrinsic size and avoid a layout-shift on load. This
                // is filtered a second time below by the `img` transformTags fn, which is the
                // real gate — allowedAttributes alone is not enough because transformTags rebuilds
                // the attribute object from scratch and runs BEFORE allowedAttributes filtering
                // (see sanitize-html's applyPerTagBaseAttributes ordering), so an unvalidated entry
                // here would be silently dropped, not silently accepted.
                img: ['src', 'alt', 'loading', 'decoding', 'width', 'height', 'srcset'],

                // title is only set in the case of an external link warning
                a: ['href', 'rel', 'title', 'class', 'target', 'id'],

                // start attribute allows ordered lists to continue numbering after interruption
                ol: ['start']
            },
            allowedSchemes: ['http', 'https', 'hive'],
            transformTags: {
                iframe: (tagName: string, attributes: sanitize.Attributes) => {
                    const srcAtty = attributes.src;
                    for (const item of StaticConfig.sanitization.iframeWhitelist) {
                        if (item.re.test(srcAtty)) {
                            const src = typeof item.fn === 'function' ? item.fn(srcAtty) : srcAtty;
                            if (!src) {
                                break;
                            }
                            const iframeToBeReturned: sanitize.Tag = {
                                tagName: 'iframe',
                                attribs: {
                                    src,
                                    width: this.options.iframeWidth + '',
                                    height: this.options.iframeHeight + '',
                                    // some of there are deprecated but required for some embeds
                                    frameborder: '0',
                                    allowfullscreen: 'allowfullscreen',
                                    webkitallowfullscreen: 'webkitallowfullscreen',
                                    mozallowfullscreen: 'mozallowfullscreen',
                                    // ★ SANDBOX (2026-09-04, security). Defense-in-depth over the
                                    // src allowlist: even a whitelisted embed is confined. The
                                    // players need scripts + their own origin (cross-origin, so
                                    // allow-same-origin grants THEIR origin, not ours) + casting;
                                    // we deliberately OMIT allow-top-navigation and allow-popups —
                                    // those are the phishing levers (redirecting the tab / opening
                                    // windows). Fullscreen rides on `allow`/allowfullscreen, not a
                                    // sandbox token.
                                    sandbox: 'allow-scripts allow-same-origin allow-presentation',
                                    allow: 'fullscreen; picture-in-picture; encrypted-media'
                                }
                            };
                            return iframeToBeReturned;
                        }
                    }
                    Log.log().warn(`Blocked iframe (not whitelisted)${this.formatPostContext()}: src="${srcAtty || '(empty)'}"`);
                    this.sanitizationErrors.push('Invalid iframe URL: ' + srcAtty);

                    const retTag: sanitize.Tag = {tagName: 'div', text: `(Unsupported ${srcAtty})`, attribs: {}};
                    return retTag;
                },
                img: (tagName, attribs) => {
                    if (this.options.noImage) {
                        const retTagOnImagesNotAllowed: sanitize.Tag = {
                            tagName: 'div',
                            text: this.localization.noImage,
                            attribs: {}
                        };
                        return retTagOnImagesNotAllowed;
                    }
                    // See https://github.com/punkave/sanitize-html/issues/117
                    const {src, alt} = attribs;
                    // eslint-disable-next-line security/detect-unsafe-regex
                    if (!/^(https?:)?\/\//i.test(src)) {
                        Log.log().warn(`Blocked image (invalid src)${this.formatPostContext()}: src="${src || '(empty)'}"`);
                        this.sanitizationErrors.push('An image in this post did not save properly.');
                        const retTagOnNoUrl: sanitize.Tag = {
                            tagName: 'img',
                            attribs: {src: 'brokenimg.jpg'}
                        };
                        return retTagOnNoUrl;
                    }

                    const atts: sanitize.Attributes = {};
                    atts.src = src.replace(/^http:\/\//i, '//'); // replace http:// with // to force https when needed
                    if (alt && alt !== '') {
                        atts.alt = alt;
                    }
                    // 2026-08-17: preserve intrinsic width/height, presentational-only and
                    // security-safe because we require a plain unsigned-integer string
                    // (`/^\d+$/`, capped to a sane pixel range) before copying it through —
                    // there is no way to smuggle a script/style/URL vector through a bare
                    // digit string, and anything that isn't one (percentages, "auto",
                    // `1" onerror=...`, huge numbers meant to force a giant CLS-inducing box)
                    // is dropped rather than passed on. 2026-08-21: `srcset` joined them —
                    // see `isSafeSrcSet` below, which is strictly tighter than these two
                    // because it is validating urls rather than digits. width/height/srcset
                    // are the only attributes this sanitizer widens for <img>;
                    // src/alt/loading/decoding are unchanged.
                    const isSafeDimension = (v: unknown): v is string => typeof v === 'string' && /^\d{1,4}$/.test(v) && v !== '0';
                    /*
                     * `srcset` carries URLS, so it gets the same treatment `src` does and
                     * then some. Every candidate must be an absolute http(s) (or
                     * protocol-relative) url followed by a bare density descriptor — no
                     * spaces inside the url, no quotes, no angle brackets, nothing that
                     * could close the attribute and start another one. A single bad
                     * candidate drops the WHOLE attribute rather than being filtered out
                     * of it, because a partially-rewritten srcset is a silent downgrade
                     * nobody would notice.
                     *
                     * Splitting on `,` is safe HERE because this project's own
                     * `proxifyImageSrc` emits `…/p/<base58>?format=…&width=…` — base58 and
                     * query params, no commas by construction — and any candidate that did
                     * contain one would fail the per-candidate test and take the attribute
                     * with it. `w`-descriptors are deliberately NOT accepted: nothing in
                     * this codebase emits them, and accepting a syntax we never generate
                     * only widens what an author could smuggle in as raw HTML.
                     */
                    const isSafeSrcSet = (v: unknown): v is string => {
                        if (typeof v !== 'string' || v.length === 0 || v.length > 2000) return false;
                        const candidates = v.split(',');
                        if (candidates.length < 2 || candidates.length > 4) return false;
                        return candidates.every((c) => /^(?:https?:)?\/\/[^\s"'<>]+ [1-3]x$/.test(c.trim()));
                    };
                    if (isSafeDimension(attribs.width)) {
                        atts.width = attribs.width;
                    }
                    if (isSafeDimension(attribs.height)) {
                        atts.height = attribs.height;
                    }
                    if (isSafeSrcSet(attribs.srcset)) {
                        atts.srcset = attribs.srcset;
                    }
                    // Lazy-load off-screen images to reduce layout shifts during scroll sync
                    // and avoid blocking the main thread with eager decoding of large images
                    atts.loading = 'lazy';
                    atts.decoding = 'async';
                    const retTag: sanitize.Tag = {tagName, attribs: atts};
                    return retTag;
                },
                div: (tagName, attribs) => {
                    const attys: sanitize.Attributes = {};
                    const classWhitelist = ['pull-right', 'pull-left', 'pull-columns', 'text-justify', 'text-rtl', 'text-center', 'text-right', 'videoWrapper', 'phishy'];
                    const validClass = classWhitelist.find((e) => attribs.class === e);
                    if (validClass) {
                        attys.class = validClass;
                    }
                    if (validClass === 'phishy' && attribs.title === this.localization.phishingWarning) {
                        attys.title = attribs.title;
                    }
                    const retTag: sanitize.Tag = {
                        tagName,
                        attribs: attys
                    };
                    return retTag;
                },
                td: (tagName, attribs) => {
                    const attys: sanitize.Attributes = {};
                    if (attribs.style === 'text-align:right') {
                        attys.style = 'text-align:right';
                    }
                    if (attribs.style === 'text-align:center') {
                        attys.style = 'text-align:center';
                    }
                    const retTag: sanitize.Tag = {
                        tagName,
                        attribs: attys
                    };
                    return retTag;
                },
                th: (tagName, attribs) => {
                    const attys: sanitize.Attributes = {};
                    if (attribs.style === 'text-align:right') {
                        attys.style = 'text-align:right';
                    }
                    if (attribs.style === 'text-align:center') {
                        attys.style = 'text-align:center';
                    }
                    const retTag: sanitize.Tag = {
                        tagName,
                        attribs: attys
                    };
                    return retTag;
                },
                a: (tagName, attribs) => {
                    const attys: sanitize.Attributes = {...attribs};
                    let {href} = attribs;
                    if (href) {
                        href = href.trim();
                        attys.href = href;
                    }
                    if (href && !this.options.isLinkSafeFn(href)) {
                        attys.rel = this.options.addNofollowToLinks ? 'nofollow noopener' : 'noopener';
                        // attys.title = this.localization.phishingWarning;
                        attys.target = this.options.addTargetBlankToLinks ? '_blank' : '_self';
                    }
                    if (href && this.options.addExternalCssClassToMatchingLinksFn(href)) {
                        attys.class = this.options.cssClassForExternalLinks ? this.options.cssClassForExternalLinks : '';
                    } else {
                        attys.class = this.options.cssClassForInternalLinks ? this.options.cssClassForInternalLinks : '';
                    }
                    const retTag: sanitize.Tag = {
                        tagName,
                        attribs: attys
                    };
                    return retTag;
                }
            }
        };
    }
    private validate(o: TagsSanitizerOptions) {
        ow(o, 'TagsSanitizerOptions', ow.object);
        ow(o.iframeWidth, 'TagsSanitizerOptions.iframeWidth', ow.number.integer.positive);
        ow(o.iframeHeight, 'TagsSanitizerOptions.iframeHeight', ow.number.integer.positive);
        ow(o.addNofollowToLinks, 'TagsSanitizerOptions.addNofollowToLinks', ow.boolean);
        ow(o.addTargetBlankToLinks, 'TagsSanitizerOptions.addTargetBlankToLinks', ow.optional.boolean);
        ow(o.cssClassForInternalLinks, 'TagsSanitizerOptions.cssClassForInternalLinks', ow.optional.string);
        ow(o.cssClassForExternalLinks, 'TagsSanitizerOptions.cssClassForExternalLinks', ow.optional.string);
        ow(o.noImage, 'TagsSanitizerOptions.noImage', ow.boolean);
        ow(o.isLinkSafeFn, 'TagsSanitizerOptions.isLinkSafeFn', ow.function);
        ow(o.addExternalCssClassToMatchingLinksFn, 'TagsSanitizerOptions.addExternalCssClassToMatchingLinksFn', ow.function);
    }
}
export interface TagsSanitizerOptions {
    iframeWidth: number;
    iframeHeight: number;
    addNofollowToLinks: boolean;
    addTargetBlankToLinks?: boolean;
    cssClassForInternalLinks?: string;
    cssClassForExternalLinks?: string;
    noImage: boolean;
    isLinkSafeFn: (url: string) => boolean;
    addExternalCssClassToMatchingLinksFn: (url: string) => boolean;
}

export interface PostContext {
    author?: string;
    permlink?: string;
}
