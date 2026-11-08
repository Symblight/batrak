/**
 * One clause of a group's summary: its words, and the file chip after them when it names one.
 * @typedef {{ text: string, path?: string }} SummaryClause
 */

/**
 * What a group of tool calls did (`toolCalls.summaryOf`).
 * @typedef {Object} ToolGroupSummary
 * @property {SummaryClause[]} clauses
 * @property {number} failed
 * @property {number} added
 * @property {number} removed
 */

export {};
