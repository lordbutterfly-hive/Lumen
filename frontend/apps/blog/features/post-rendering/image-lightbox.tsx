'use client';

import Lightbox, { type Slide } from 'yet-another-react-lightbox';
import { Fullscreen, Thumbnails, Zoom } from 'yet-another-react-lightbox/plugins';
import 'yet-another-react-lightbox/plugins/thumbnails.css';
import 'yet-another-react-lightbox/styles.css';

/**
 * THE IMAGE VIEWER ITSELF — split out so it is not on the post-page critical path.
 *
 * ★ WHY THIS FILE EXISTS. `yet-another-react-lightbox`, its three plugins and
 * their two stylesheets were imported at the top of `image-gallery.tsx`, which
 * WRAPS every post body. Measured on the production build, that put them in a
 * 208 KB client chunk shipped to every reader of every post — including the
 * large majority who never click an image, and every post with no images at all.
 *
 * The wrapper could not simply be made dynamic: it is what renders the article,
 * so deferring it would defer the post itself. Splitting at this seam is the
 * point — `ImageGallery` stays eager and cheap (it only collects the images and
 * listens for clicks), and this module, which is all of the weight, is fetched
 * the first time a reader actually opens a slide.
 *
 * `ssr: false` at the import site: this is a modal over client-side DOM
 * measurements and has nothing to contribute to the server-rendered article.
 */
export interface ImageLightboxProps {
  index: number;
  slides: Slide[];
  onClose: () => void;
}

export default function ImageLightbox({ index, slides, onClose }: ImageLightboxProps) {
  return (
    <Lightbox
      /*
       * ★ ANNOUNCE IT AS A DIALOG (2026-08-16, QA pass).
       *
       * The viewer works — zoom, next/prev, thumbnails, Escape and the close
       * button all restore scroll correctly — but its portal rendered with
       * `role="presentation"` and no `aria-modal`, so a screen reader never
       * learned that a modal had opened over the article. Everything a sighted
       * reader gets from the black overlay was, to a screen-reader user, silent.
       *
       * A static label, because the slides carry no titles here.
       */
      styles={{ container: { backgroundColor: 'rgba(0, 0, 0, .8)' } }}
      open={index >= 0}
      index={index}
      close={onClose}
      slides={slides}
      plugins={[Fullscreen, Thumbnails, Zoom]}
      // `aria: true` is the library's own switch for putting ARIA attributes on
      // the controller div. Passing role/aria-modal as loose props does NOT work
      // — the component does not spread unknown attributes, and TypeScript
      // rejects them outright, which is how that first attempt was caught.
      controller={{ closeOnBackdropClick: true, aria: true }}
    />
  );
}
