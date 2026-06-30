/**
 * Minimal runtime polyfills so the read-only export runs on iOS Safari 12.x.
 *
 * esbuild (build.target: "safari12") already downlevels modern *syntax* (`?.`, `??`,
 * etc.). These cover the *method-level* gaps the reused viewer components rely on but
 * esbuild does not polyfill:
 *   - Element/Document/DocumentFragment.prototype.replaceChildren  (Safari 14+)
 *   - Array.prototype.flatMap                                      (Safari 12, just in case)
 *
 * Imported first by viewer.ts.
 */

type AnyNode = Node & { replaceChildren?: (...nodes: (Node | string)[]) => void };

if (typeof Element !== "undefined" && !("replaceChildren" in Element.prototype)) {
  const replaceChildren = function (this: Node, ...nodes: (Node | string)[]): void {
    while (this.firstChild) this.removeChild(this.firstChild);
    for (const n of nodes) {
      this.appendChild(typeof n === "string" ? document.createTextNode(n) : n);
    }
  };
  for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
    (proto as AnyNode).replaceChildren = replaceChildren;
  }
}

if (typeof Array.prototype.flatMap !== "function") {
  // eslint-disable-next-line no-extend-native
  (Array.prototype as unknown as { flatMap: unknown }).flatMap = function <T, U>(
    this: T[],
    cb: (value: T, index: number, array: T[]) => U | U[],
    thisArg?: unknown,
  ): U[] {
    return this.reduce<U[]>((acc, v, i) => acc.concat(cb.call(thisArg, v, i, this)), []);
  };
}
