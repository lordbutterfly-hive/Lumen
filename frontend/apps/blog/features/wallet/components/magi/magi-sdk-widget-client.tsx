'use client';

/**
 * A local module that imports the SDK widget STATICALLY, so magi-sdk-swap.tsx
 * can `next/dynamic` this file (ssr: false) instead of the package.
 *
 * ★ WHY THE INDIRECTION. `next/dynamic(() => import('@vsc.eco/crosschain-widget'))`
 * failed the production build with "Package path . is not exported": Next's SWC
 * transform adds `require.resolveWeak(<package>)` for SSR bookkeeping, and that
 * CommonJS request has no matching condition in the widget's import-only
 * `exports` map (crosschain-widget/package.json: `.` = { types, import }).
 * @vsc.eco/crosschain-core and -sdk have the same map and compile fine because
 * they are imported statically. Targeting a local file keeps the weak resolve
 * on our own module, and the static import here takes the `import` condition.
 */
import { MagiQuickSwap } from '@vsc.eco/crosschain-widget';

export default MagiQuickSwap;
