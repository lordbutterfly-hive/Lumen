'use client';

import { PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { Slide } from 'yet-another-react-lightbox';

/**
 * ★ THE VIEWER IS LOADED ON FIRST OPEN, NOT ON EVERY POST (2026-08-15).
 *
 * `yet-another-react-lightbox` + Fullscreen/Thumbnails/Zoom + two stylesheets
 * used to be imported here, at the top of the component that wraps EVERY post
 * body — a 208 KB client chunk shipped to every reader of every post, including
 * posts with no images and readers who never click one. See `./image-lightbox`.
 *
 * This wrapper must stay eager: it renders the article. Only the modal is
 * deferred, and only until the reader actually opens a slide.
 *
 * `type Slide` is a TYPE-only import, so it is erased at compile time and pulls
 * nothing into the bundle — the runtime import lives solely in the chunk below.
 */
const ImageLightbox = dynamic(() => import('./image-lightbox'), { ssr: false });

const IMAGE_QUERY_SELECTOR = ':not(a) > img';

const ImageGallery = ({ children }: PropsWithChildren) => {
  const [slides, setSlides] = useState<Slide[]>([]);
  const [index, setIndex] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIndex(-1), []);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const images = Array.from(root.querySelectorAll<HTMLImageElement>(IMAGE_QUERY_SELECTOR));
    if (images.length === 0) return;

    setSlides(
      images.map((image) => ({
        src: image.src,
        srcSet: [{ src: image.src, width: image.width, height: image.height }]
      }))
    );

    /*
     * ★ THE LISTENERS ARE KEPT SO THEY CAN ACTUALLY BE REMOVED.
     *
     * The cleanup used to call `openOnIndex(i)` a second time, which builds a
     * NEW function object — and `removeEventListener` matches on identity, so
     * it removed nothing. Every change to `children` therefore added another
     * click listener to every image on top of the ones already there, and a
     * long reading session accumulated them for the life of the page.
     */
    const bound = images.map((image, i) => {
      const handler = () => setIndex(i);
      image.addEventListener('click', handler);
      return { image, handler };
    });

    return () => {
      for (const { image, handler } of bound) image.removeEventListener('click', handler);
    };
  }, [children]);

  return (
    <div>
      {index >= 0 ? <ImageLightbox index={index} slides={slides} onClose={close} /> : null}
      <div ref={ref}>{children}</div>
    </div>
  );
};

export default ImageGallery;
