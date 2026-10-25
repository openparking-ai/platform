import { renameSync, writeFileSync } from 'node:fs';

/**
 * The stand-in's state, written beside its file and renamed over it: the
 * suite reads the file while a door call writes it, and a reader meets it
 * whole, before or after, never cut short.
 */
export function writeStandInState(file, state) {
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(state));
  renameSync(partial, file);
}
