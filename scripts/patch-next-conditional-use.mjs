/**
 * Patch Next.js 16.4.x for React 19.3's conditional-use() warning.
 *
 * Next's App Router sometimes calls use(promise) only while router/RSC state
 * is thenable (use-action-queue) or only on the deferred-RSC / missing-data
 * path (layout-router). After the promise settles, the same fiber finishes
 * without calling use(), which React 19.3 logs as:
 *   "This library called use() to suspend in a previous render but did not
 *    call use() when it finished."
 *
 * Used by `yarn patch` / postinstall. Pass the package root as argv[2].
 */
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: patch-next-conditional-use.mjs <next-package-root>");
  process.exit(1);
}

const fulfilledHelper = `
const fulfilledRscPromises = new WeakMap();
function fulfilledRscPromise(value) {
  if (value !== null && typeof value === "object") {
    let promise = fulfilledRscPromises.get(value);
    if (promise) return promise;
    promise = Promise.resolve(value);
    promise.status = "fulfilled";
    promise.value = value;
    fulfilledRscPromises.set(value, promise);
    return promise;
  }
  const promise = Promise.resolve(value);
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}
`;

function patchFile(rel, transform) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.warn("skip missing", rel);
    return;
  }
  const before = fs.readFileSync(file, "utf8");
  const after = transform(before);
  if (after === before) {
    console.warn("no changes", rel);
    return;
  }
  fs.writeFileSync(file, after);
  console.log("patched", rel);
}

function patchUseActionQueue(source, style) {
  if (style === "cjs") {
    const from =
      "    return (0, _isthenable.isThenable)(stateWithDebugInfo) ? (0, _react.use)(stateWithDebugInfo) : stateWithDebugInfo;";
    const to = `    // Fitboard: always call use() so React 19.3 does not warn when state flips from thenable → plain.
    const statePromise = (0, _react.useMemo)(()=>{
        if ((0, _isthenable.isThenable)(stateWithDebugInfo)) {
            return stateWithDebugInfo;
        }
        const fulfilled = Promise.resolve(stateWithDebugInfo);
        fulfilled.status = 'fulfilled';
        fulfilled.value = stateWithDebugInfo;
        return fulfilled;
    }, [
        stateWithDebugInfo
    ]);
    return (0, _react.use)(statePromise);`;
    if (!source.includes(from)) throw new Error("cjs use-action-queue pattern missing");
    return source.replace(from, to);
  }

  const from =
    "    return isThenable(stateWithDebugInfo) ? use(stateWithDebugInfo) : stateWithDebugInfo;";
  const to = `    // Fitboard: always call use() so React 19.3 does not warn when state flips from thenable → plain.
    const statePromise = useMemo(()=>{
        if (isThenable(stateWithDebugInfo)) {
            return stateWithDebugInfo;
        }
        const fulfilled = Promise.resolve(stateWithDebugInfo);
        fulfilled.status = 'fulfilled';
        fulfilled.value = stateWithDebugInfo;
        return fulfilled;
    }, [
        stateWithDebugInfo
    ]);
    return use(statePromise);`;
  if (!source.includes(from)) throw new Error("esm use-action-queue pattern missing");
  return source.replace(from, to);
}

function patchLayoutRouterCjs(source) {
  if (source.includes("fulfilledRscPromise(")) return source;

  const marker = 'const _react = /*#__PURE__*/ _interop_require_wildcard._(require("react"));';
  if (!source.includes(marker)) throw new Error("cjs layout-router react import missing");
  source = source.replace(marker, marker + "\n" + fulfilledHelper);

  const block = `    let resolvedRsc;
    if ((0, _rendertree.isDeferredRsc)(rsc)) {
        const unwrappedRsc = (0, _react.use)(rsc);
        if (unwrappedRsc === null) {
            // If the promise was resolved to \`null\`, it means the data for this
            // segment was not returned by the server. Suspend indefinitely. When this
            // happens, the router is responsible for triggering a new state update to
            // un-suspend this segment.
            (0, _react.use)(_unresolvedthenable.unresolvedThenable);
        }
        resolvedRsc = unwrappedRsc;
    } else {
        // This is not a deferred RSC promise. Don't need to unwrap it.
        if (rsc === null) {
            (0, _react.use)(_unresolvedthenable.unresolvedThenable);
        }
        resolvedRsc = rsc;
    }`;

  const replacement = `    let resolvedRsc;
    // Fitboard: always use() (fulfilled wrapper when resolved) so switching from a
    // deferred RSC promise to a plain node does not trip React 19.3's conditional-use warning.
    // Forever-suspend with throw instead of use(unresolvedThenable) for the same reason.
    if (rsc === null) {
        throw _unresolvedthenable.unresolvedThenable;
    }
    if ((0, _rendertree.isDeferredRsc)(rsc)) {
        resolvedRsc = (0, _react.use)(rsc);
    } else {
        resolvedRsc = (0, _react.use)(fulfilledRscPromise(rsc));
    }
    if (resolvedRsc === null) {
        throw _unresolvedthenable.unresolvedThenable;
    }`;

  if (!source.includes(block)) throw new Error("cjs layout-router resolvedRsc block missing");
  source = source.replace(block, replacement);

  const forever = `(0, _react.use)(_unresolvedthenable.unresolvedThenable);`;
  const foreverThrow = `throw _unresolvedthenable.unresolvedThenable;`;
  if (!source.includes(forever)) throw new Error("cjs layout-router forever-suspend use() missing");
  source = source.replaceAll(forever, foreverThrow);

  return source;
}

function patchLayoutRouterEsm(source) {
  if (source.includes("fulfilledRscPromise(")) return source;

  const marker = "import { isDeferredRsc } from './render-tree';";
  if (!source.includes(marker)) throw new Error("esm layout-router import missing");
  source = source.replace(marker, marker + "\n" + fulfilledHelper);

  const block = `    let resolvedRsc;
    if (isDeferredRsc(rsc)) {
        const unwrappedRsc = use(rsc);
        if (unwrappedRsc === null) {
            // If the promise was resolved to \`null\`, it means the data for this
            // segment was not returned by the server. Suspend indefinitely. When this
            // happens, the router is responsible for triggering a new state update to
            // un-suspend this segment.
            use(unresolvedThenable);
        }
        resolvedRsc = unwrappedRsc;
    } else {
        // This is not a deferred RSC promise. Don't need to unwrap it.
        if (rsc === null) {
            use(unresolvedThenable);
        }
        resolvedRsc = rsc;
    }`;

  const replacement = `    let resolvedRsc;
    // Fitboard: always use() (fulfilled wrapper when resolved) so switching from a
    // deferred RSC promise to a plain node does not trip React 19.3's conditional-use warning.
    // Forever-suspend with throw instead of use(unresolvedThenable) for the same reason.
    if (rsc === null) {
        throw unresolvedThenable;
    }
    if (isDeferredRsc(rsc)) {
        resolvedRsc = use(rsc);
    } else {
        resolvedRsc = use(fulfilledRscPromise(rsc));
    }
    if (resolvedRsc === null) {
        throw unresolvedThenable;
    }`;

  if (!source.includes(block)) throw new Error("esm layout-router resolvedRsc block missing");
  source = source.replace(block, replacement);

  const forever = `use(unresolvedThenable);`;
  const foreverThrow = `throw unresolvedThenable;`;
  if (!source.includes(forever)) throw new Error("esm layout-router forever-suspend use() missing");
  source = source.replaceAll(forever, foreverThrow);

  return source;
}

function patchNavigation(source, style) {
  // Skip Suspense DevTools instrumentation that conditionally use()s navigation promises.
  if (style === "cjs") {
    const from =
      "    if (process.env.NODE_ENV !== 'production' && 'use' in _react.default) {";
    const to =
      "    if (false && process.env.NODE_ENV !== 'production' && 'use' in _react.default) {";
    if (!source.includes(from)) throw new Error("cjs navigation instrumentation guard missing");
    return source.replaceAll(from, to);
  }
  const from = "    if (process.env.NODE_ENV !== 'production' && 'use' in React) {";
  const to = "    if (false && process.env.NODE_ENV !== 'production' && 'use' in React) {";
  // useSelectedLayoutSegment has a slightly different guard — handle both.
  let out = source.replaceAll(from, to);
  const from2 =
    "    if (\n        process.env.NODE_ENV !== 'production' &&\n        navigationPromises &&\n        'use' in React\n    ) {";
  const to2 =
    "    if (\n        false &&\n        process.env.NODE_ENV !== 'production' &&\n        navigationPromises &&\n        'use' in React\n    ) {";
  if (out.includes(from2)) out = out.replaceAll(from2, to2);
  const from2min =
    "    if (process.env.NODE_ENV !== 'production' &&\n        navigationPromises &&\n        'use' in React) {";
  // Also handle single-line-ish cjs variant for useSelectedLayoutSegment in cjs file
  return out;
}

function patchNavigationCjsSelected(source) {
  const from =
    `    if (process.env.NODE_ENV !== 'production' && navigationPromises && 'use' in _react.default) {`;
  const to =
    `    if (false && process.env.NODE_ENV !== 'production' && navigationPromises && 'use' in _react.default) {`;
  if (source.includes(from)) return source.replaceAll(from, to);
  // multiline form in compiled output
  const fromMulti = `    if (process.env.NODE_ENV !== 'production' && navigationPromises && 'use' in _react.default) {`;
  return source.includes(fromMulti) ? source.replaceAll(fromMulti, to) : source;
}

patchFile("dist/client/components/use-action-queue.js", (s) => patchUseActionQueue(s, "cjs"));
patchFile("dist/esm/client/components/use-action-queue.js", (s) => patchUseActionQueue(s, "esm"));
patchFile("dist/client/components/layout-router.js", patchLayoutRouterCjs);
patchFile("dist/esm/client/components/layout-router.js", patchLayoutRouterEsm);
patchFile("dist/client/components/navigation.js", (s) => patchNavigationCjsSelected(patchNavigation(s, "cjs")));
patchFile("dist/esm/client/components/navigation.js", (s) => patchNavigation(s, "esm"));
