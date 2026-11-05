import { configOf, currentName } from './options.js';
import { runTargetOf } from './run-target.js';

/** The rules about the composer: the options an agent offers (model and mode), and where a draft runs. */
export const composer = Object.freeze({ configOf, currentName, runTargetOf });
