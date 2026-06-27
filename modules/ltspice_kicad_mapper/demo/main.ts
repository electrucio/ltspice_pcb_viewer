import "../src/index.js";
import type { LtspiceKicadMapperElement } from "../src/index.js";

const mapper = document.getElementById("m") as LtspiceKicadMapperElement;

async function boot(): Promise<void> {
  // register the project's custom potentiometer symbols on the LTspice side first
  for (const name of ["lin_pot", "log_pot", "revlog_pot"]) {
    const asy = await fetch(`./${name}.asy`).then((r) => (r.ok ? r.text() : ""));
    if (asy) mapper.registerLtspiceSymbol(name, asy);
  }
  await Promise.all([
    mapper.loadLtspiceUrl("./AudioAmpCompl-40W.asc"),
    mapper.loadKicadUrl("./poweramp.kicad_sch"),
  ]);
}

mapper.addEventListener("mappingchange", (e) => {
  console.log("mapping changed:", (e as CustomEvent).detail);
});

void boot();
