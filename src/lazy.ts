import { createElement, use, type ComponentProps, type ComponentType, type ReactNode } from "react";

export type PreloadablePage<T extends ComponentType<any>> =
  ((props: ComponentProps<T>) => ReactNode) & { preload: () => void };

const failed = new Set<() => void>();

/** Let every page whose download failed try again on its next render. The error
 *  panel calls this: until then a failure stays put, so React can show it. */
export function forgetFailedPages(): void {
  for (const forget of failed) forget();
  failed.clear();
}

/** A page loaded on demand, with a handle to start the download early.
 *
 *  Like React.lazy, but a failed download is forgotten: React.lazy keeps a
 *  rejected import rejected for good, so the error panel's "try again" could
 *  never recover from one dropped request. Here `forgetFailedPages()` clears it. */
// `any` mirrors React.lazy's own signature; the props are still inferred per page.
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): PreloadablePage<T> {
  let loading: Promise<{ default: T }> | null = null;
  let loaded: { default: T } | null = null;
  const get = () => (loading ??= load().then(
    (m) => (loaded = m),
    (e) => { failed.add(() => { loading = null; }); throw e; }));
  const Page = (props: ComponentProps<T>) =>
    createElement((loaded ?? use(get())).default as ComponentType<any>, props);
  return Object.assign(Page, { preload: () => { get().catch(() => {}); } });
}

/** Run `fn` when the browser is idle (or soon, where it has no idle callback). */
export function whenIdle(fn: () => void, timeout = 1500): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(fn, 200);
  return () => window.clearTimeout(id);
}
