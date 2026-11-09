import { liveLine, rowOf, summaryOf } from './rules.js';

/** How a reply's tool calls read on the page: its work row's summary, live line and rows. */
export const toolCalls = Object.freeze({
  summaryOf,
  rowOf,
  liveLine,
});
