import { kindVerb, liveLine, progressive, summaryOf } from './rules.js';

/** How a reply's tool calls read on the page: its work row's summary and live line. */
export const toolCalls = Object.freeze({
  summaryOf,
  progressive,
  liveLine,
  kindVerb,
});
