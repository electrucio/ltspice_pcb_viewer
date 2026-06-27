/**
 * Embedded built-in LTspice symbol library, in `.asy` source form.
 *
 * LTspice ships these symbol geometries with the application (not in the .asc), so
 * a browser viewer must carry its own copy. This set covers the common primitives;
 * custom/third-party symbols can be supplied at runtime via registerSymbol().
 *
 * (Ported from the asc_viewer.html reference in the guitar_amplifier project.)
 */

import { parseAsy, type SymbolDef } from "../parser/asy.js";

export const BUILTIN_ASY: Record<string, string> = {
  res: "LINE Normal 16 88 16 96\nLINE Normal 0 80 16 88\nLINE Normal 32 64 0 80\nLINE Normal 0 48 32 64\nLINE Normal 32 32 0 48\nLINE Normal 16 16 16 24\nLINE Normal 16 24 32 32\nWINDOW 0 36 40 Left 2\nWINDOW 3 36 76 Left 2\nSYMATTR Value R\nSYMATTR Prefix R\nPIN 16 16 NONE 0\nPIN 16 96 NONE 0",
  res2: "LINE Normal 16 0 32 4\nLINE Normal 0 12 32 4\nLINE Normal 0 12 32 20\nLINE Normal 0 28 32 20\nLINE Normal 0 28 32 36\nLINE Normal 0 44 32 36\nLINE Normal 0 44 32 52\nLINE Normal 0 60 32 52\nLINE Normal 0 60 16 64\nWINDOW 0 36 16 Left 2\nWINDOW 3 36 56 Left 2\nSYMATTR Value R\nSYMATTR Prefix R\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  cap: "LINE Normal 16 36 16 64\nLINE Normal 16 28 16 0\nLINE Normal 0 28 32 28\nLINE Normal 0 36 32 36\nWINDOW 0 24 8 Left 2\nWINDOW 3 24 56 Left 2\nSYMATTR Value C\nSYMATTR Prefix C\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  polcap: "LINE Normal 16 36 16 64\nLINE Normal 16 0 16 28\nLINE Normal 8 12 8 20\nLINE Normal 4 16 12 16\nLINE Normal 0 28 32 28\nARC Normal -16 36 48 100 32 40 0 40\nWINDOW 0 24 8 Left 2\nWINDOW 3 24 57 Left 2\nSYMATTR Value C\nSYMATTR Prefix C\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  ind: "ARC Normal 0 40 32 72 4 68 4 44\nARC Normal 0 64 32 96 16 96 4 68\nARC Normal 0 16 32 48 4 44 16 16\nWINDOW 0 36 40 Left 2\nWINDOW 3 36 80 Left 2\nSYMATTR Value L\nSYMATTR Prefix L\nPIN 16 16 NONE 0\nPIN 16 96 NONE 0",
  ind2: "CIRCLE Normal 4 80 12 88\nARC Normal 0 40 32 72 4 68 4 44\nARC Normal 0 64 32 96 16 96 4 68\nARC Normal 0 16 32 48 4 44 16 16\nWINDOW 0 36 40 Left 2\nWINDOW 3 36 80 Left 2\nSYMATTR Value L\nSYMATTR Prefix L\nPIN 16 16 NONE 0\nPIN 16 96 NONE 0",
  diode: "LINE Normal 0 44 32 44\nLINE Normal 0 20 32 20\nLINE Normal 32 20 16 44\nLINE Normal 0 20 16 44\nLINE Normal 16 0 16 20\nLINE Normal 16 44 16 64\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 64 Left 2\nSYMATTR Value D\nSYMATTR Prefix D\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  zener: "LINE Normal 0 44 -4 48\nLINE Normal 32 44 36 40\nLINE Normal 0 44 32 44\nLINE Normal 0 20 32 20\nLINE Normal 32 20 16 44\nLINE Normal 0 20 16 44\nLINE Normal 16 0 16 20\nLINE Normal 16 44 16 64\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 64 Left 2\nSYMATTR Value D\nSYMATTR Prefix D\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  schottky: "LINE Normal 0 36 4 36\nLINE Normal 0 44 0 36\nLINE Normal 0 44 32 44\nLINE Normal 32 44 32 52\nLINE Normal 32 52 28 52\nLINE Normal 0 20 32 20\nLINE Normal 32 20 16 44\nLINE Normal 0 20 16 44\nLINE Normal 16 0 16 20\nLINE Normal 16 44 16 64\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 64 Left 2\nSYMATTR Value D\nSYMATTR Prefix D\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  LED: "LINE Normal 0 44 32 44\nLINE Normal 0 20 32 20\nLINE Normal 32 20 16 44\nLINE Normal 0 20 16 44\nLINE Normal 16 0 16 20\nLINE Normal 16 44 16 64\nLINE Normal 72 32 68 40\nLINE Normal 72 32 64 32\nLINE Normal 72 48 68 56\nLINE Normal 72 48 64 48\nARC Normal 40 20 56 36 56 28 40 24\nARC Normal 56 20 72 36 56 28 72 32\nARC Normal 40 36 56 52 56 44 40 40\nARC Normal 56 36 72 52 56 44 72 48\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 64 Left 2\nSYMATTR Value D\nSYMATTR Prefix D\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
  npn: "LINE Normal 44 76 36 84\nLINE Normal 64 96 44 76\nLINE Normal 64 96 36 84\nLINE Normal 40 80 16 64\nLINE Normal 16 80 16 16\nLINE Normal 16 32 64 0\nLINE Normal 16 48 0 48\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 68 Left 2\nSYMATTR Value NPN\nSYMATTR Prefix QN\nPIN 64 0 NONE 0\nPIN 0 48 NONE 0\nPIN 64 96 NONE 0",
  pnp: "LINE Normal 16 64 44 76\nLINE Normal 44 76 36 84\nLINE Normal 16 64 36 84\nLINE Normal 40 80 64 96\nLINE Normal 16 80 16 16\nLINE Normal 16 32 64 0\nLINE Normal 16 48 0 48\nWINDOW 0 84 32 Left 2\nWINDOW 3 84 68 Left 2\nSYMATTR Value PNP\nSYMATTR Prefix QP\nPIN 64 0 NONE 0\nPIN 0 48 NONE 0\nPIN 64 96 NONE 0",
  npn2: "LINE Normal 44 76 36 84\nLINE Normal 64 96 44 76\nLINE Normal 64 96 36 84\nLINE Normal 40 80 16 64\nLINE Normal 16 32 64 0\nLINE Normal 12 48 0 48\nRECTANGLE Normal 16 72 12 24\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 68 Left 2\nSYMATTR Value NPN\nSYMATTR Prefix QN\nPIN 64 0 NONE 0\nPIN 0 48 NONE 0\nPIN 64 96 NONE 0",
  pnp2: "LINE Normal 16 64 44 76\nLINE Normal 44 76 36 84\nLINE Normal 16 64 36 84\nLINE Normal 40 80 64 96\nLINE Normal 16 32 64 0\nLINE Normal 12 48 0 48\nRECTANGLE Normal 16 72 12 24\nWINDOW 0 84 32 Left 2\nWINDOW 3 84 68 Left 2\nSYMATTR Value PNP\nSYMATTR Prefix QP\nPIN 64 0 NONE 0\nPIN 0 48 NONE 0\nPIN 64 96 NONE 0",
  nmos: "LINE Normal 48 48 48 96\nLINE Normal 16 80 48 80\nLINE Normal 40 48 48 48\nLINE Normal 16 48 40 44\nLINE Normal 16 48 40 52\nLINE Normal 40 44 40 52\nLINE Normal 16 8 16 24\nLINE Normal 16 40 16 56\nLINE Normal 16 72 16 88\nLINE Normal 0 80 8 80\nLINE Normal 8 16 8 80\nLINE Normal 48 16 16 16\nLINE Normal 48 0 48 16\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value NMOS\nSYMATTR Prefix MN\nPIN 48 0 NONE 0\nPIN 0 80 NONE 0\nPIN 48 96 NONE 0",
  pmos: "LINE Normal 48 48 48 96\nLINE Normal 16 80 48 80\nLINE Normal 16 48 24 48\nLINE Normal 48 48 24 44\nLINE Normal 48 48 24 52\nLINE Normal 24 44 24 52\nLINE Normal 16 8 16 24\nLINE Normal 16 40 16 56\nLINE Normal 16 72 16 88\nLINE Normal 0 80 8 80\nLINE Normal 8 16 8 80\nLINE Normal 48 16 16 16\nLINE Normal 48 0 48 16\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value PMOS\nSYMATTR Prefix MP\nPIN 48 0 NONE 0\nPIN 0 80 NONE 0\nPIN 48 96 NONE 0",
  nmos4: "LINE Normal 48 80 48 96\nLINE Normal 16 80 48 80\nLINE Normal 40 48 48 48\nLINE Normal 16 48 40 44\nLINE Normal 16 48 40 52\nLINE Normal 40 44 40 52\nLINE Normal 16 8 16 24\nLINE Normal 16 40 16 56\nLINE Normal 16 72 16 88\nLINE Normal 0 80 8 80\nLINE Normal 8 16 8 80\nLINE Normal 48 16 16 16\nLINE Normal 48 0 48 16\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value NMOS\nSYMATTR Prefix MN\nPIN 48 0 NONE 0\nPIN 0 80 NONE 0\nPIN 48 96 NONE 0\nPIN 48 48 NONE 0",
  pmos4: "LINE Normal 48 80 48 96\nLINE Normal 16 80 48 80\nLINE Normal 16 48 24 48\nLINE Normal 48 48 24 44\nLINE Normal 48 48 24 52\nLINE Normal 24 44 24 52\nLINE Normal 16 8 16 24\nLINE Normal 16 40 16 56\nLINE Normal 16 72 16 88\nLINE Normal 0 80 8 80\nLINE Normal 8 16 8 80\nLINE Normal 48 16 16 16\nLINE Normal 48 0 48 16\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value PMOS\nSYMATTR Prefix MP\nPIN 48 0 NONE 0\nPIN 0 80 NONE 0\nPIN 48 96 NONE 0\nPIN 48 48 NONE 0",
  njf: "LINE Normal 16 16 16 80\nLINE Normal 48 72 48 96\nLINE Normal 16 72 48 72\nLINE Normal 48 24 48 0\nLINE Normal 16 24 48 24\nLINE Normal 0 64 4 64\nLINE Normal 4 68 16 64\nLINE Normal 4 60 16 64\nLINE Normal 4 60 4 68\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value NJF\nSYMATTR Prefix JN\nPIN 48 0 NONE 0\nPIN 0 64 NONE 0\nPIN 48 96 NONE 0",
  pjf: "LINE Normal 16 16 16 80\nLINE Normal 48 72 48 96\nLINE Normal 16 72 48 72\nLINE Normal 48 24 48 0\nLINE Normal 16 24 48 24\nLINE Normal 12 64 16 64\nLINE Normal 12 68 0 64\nLINE Normal 12 60 0 64\nLINE Normal 12 60 12 68\nWINDOW 0 56 32 Left 2\nWINDOW 3 56 72 Left 2\nSYMATTR Value PJF\nSYMATTR Prefix JP\nPIN 48 0 NONE 0\nPIN 0 64 NONE 0\nPIN 48 96 NONE 0",
  voltage: "LINE Normal -8 36 8 36\nLINE Normal -8 76 8 76\nLINE Normal 0 28 0 44\nLINE Normal 0 96 0 88\nLINE Normal 0 16 0 24\nCIRCLE Normal -32 24 32 88\nWINDOW 0 24 16 Left 2\nWINDOW 3 24 96 Left 2\nSYMATTR Value V\nSYMATTR Prefix V\nPIN 0 16 NONE 0\nPIN 0 96 NONE 0",
  current: "LINE Normal 0 56 4 44\nLINE Normal 0 56 -4 44\nLINE Normal -4 44 4 44\nLINE Normal 0 24 0 44\nLINE Normal 0 80 0 72\nLINE Normal 0 0 0 8\nCIRCLE Normal -32 8 32 72\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 80 Left 2\nSYMATTR Value I\nSYMATTR Prefix I\nPIN 0 0 NONE 0\nPIN 0 80 NONE 0",
  bv: "LINE Normal -8 36 8 36\nLINE Normal -8 76 8 76\nLINE Normal 0 28 0 44\nLINE Normal 0 96 0 88\nLINE Normal 0 16 0 24\nCIRCLE Normal -32 24 32 88\nWINDOW 0 24 16 Left 2\nWINDOW 3 24 96 Left 2\nSYMATTR Value V=F(...)\nSYMATTR Prefix B\nPIN 0 16 NONE 0\nPIN 0 96 NONE 0",
  bi: "LINE Normal 0 56 4 44\nLINE Normal 0 56 -4 44\nLINE Normal -4 44 4 44\nLINE Normal 0 24 0 44\nLINE Normal 0 80 0 72\nLINE Normal 0 0 0 8\nCIRCLE Normal -32 8 32 72\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 80 Left 2\nSYMATTR Value I=F(...)\nSYMATTR Prefix B\nPIN 0 0 NONE 0\nPIN 0 80 NONE 0",
  e: "LINE Normal -48 32 -32 32\nLINE Normal -32 32 -24 36\nLINE Normal -48 80 -32 80\nLINE Normal -32 80 -24 76\nLINE Normal 0 16 0 24\nLINE Normal 0 96 0 88\nLINE Normal -48 72 -40 72\nLINE Normal -48 40 -40 40\nLINE Normal -44 36 -44 44\nLINE Normal -4 72 4 72\nLINE Normal -4 40 4 40\nLINE Normal 0 36 0 44\nCIRCLE Normal -32 24 32 88\nWINDOW 0 24 16 Left 2\nWINDOW 3 24 96 Left 2\nSYMATTR Value E\nSYMATTR Prefix E\nPIN 0 16 NONE 0\nPIN 0 96 NONE 0\nPIN -48 32 NONE 0\nPIN -48 80 NONE 0",
  g: "LINE Normal -48 32 -32 32\nLINE Normal -32 32 -24 36\nLINE Normal -48 80 -32 80\nLINE Normal -32 80 -24 76\nLINE Normal 0 16 0 24\nLINE Normal 0 96 0 88\nLINE Normal -48 72 -40 72\nLINE Normal -48 40 -40 40\nLINE Normal -44 36 -44 44\nLINE Normal 4 52 0 40\nLINE Normal -4 52 0 40\nLINE Normal -4 52 4 52\nLINE Normal 0 52 0 72\nCIRCLE Normal -32 24 32 88\nWINDOW 0 24 16 Left 2\nWINDOW 3 24 96 Left 2\nSYMATTR Value G\nSYMATTR Prefix G\nPIN 0 96 NONE 0\nPIN 0 16 NONE 0\nPIN -48 32 NONE 0\nPIN -48 80 NONE 0",
  sw: "LINE Normal -48 32 -32 32\nLINE Normal -32 32 -24 36\nLINE Normal -48 80 -32 80\nLINE Normal -32 80 -24 76\nLINE Normal 0 96 0 72\nLINE Normal 0 16 0 36\nLINE Normal 0 36 20 60\nLINE Normal -48 72 -40 72\nLINE Normal -44 76 -44 68\nLINE Normal -48 40 -40 40\nCIRCLE Normal -32 24 32 88\nCIRCLE Normal -4 76 4 68\nCIRCLE Normal 16 56 24 64\nWINDOW 0 24 16 Left 2\nWINDOW 3 24 96 Left 2\nSYMATTR Value SW\nSYMATTR Prefix S\nPIN 0 16 NONE 0\nPIN 0 96 NONE 0\nPIN -48 80 NONE 0\nPIN -48 32 NONE 0",
  varactor: "LINE Normal 0 36 32 36\nLINE Normal 0 44 32 44\nLINE Normal 0 16 32 16\nLINE Normal 32 16 16 36\nLINE Normal 0 16 16 36\nLINE Normal 16 0 16 16\nLINE Normal 16 44 16 64\nWINDOW 0 24 0 Left 2\nWINDOW 3 24 64 Left 2\nSYMATTR Value D\nSYMATTR Prefix D\nPIN 16 0 NONE 0\nPIN 16 64 NONE 0",
};

/**
 * Resolves symbol names to parsed definitions. Lookup is case-insensitive and
 * path-insensitive (LTspice references like "res" or "lib\\foo"). User-supplied
 * `.asy` definitions take precedence over the built-ins.
 */
export class SymbolLibrary {
  private user = new Map<string, SymbolDef>();
  private cache = new Map<string, SymbolDef>();

  /** Register a custom symbol from raw `.asy` text. */
  register(name: string, asyText: string): void {
    this.user.set(baseName(name), parseAsy(asyText));
  }

  lookup(name: string): SymbolDef | null {
    const base = baseName(name);
    const u = this.user.get(base);
    if (u) return u;
    const c = this.cache.get(base);
    if (c) return c;
    const key = Object.keys(BUILTIN_ASY).find((k) => k.toLowerCase() === base);
    if (key) {
      const def = parseAsy(BUILTIN_ASY[key]!);
      this.cache.set(base, def);
      return def;
    }
    return null;
  }
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop()!.toLowerCase();
}
