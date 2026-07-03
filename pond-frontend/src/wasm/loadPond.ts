import createPondModule from "./pond.js";

export async function loadPond() {
  const mod = await createPondModule({
    locateFile: (path: string) => `/${path}`,  // still points wasm at /pond.wasm
  });
  return mod;
}