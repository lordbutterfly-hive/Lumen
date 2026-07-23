/**
 * Shared grid-template-columns strings so the header row and every data
 * row line up exactly. `general` mirrors the design handoff's 8-column
 * layout (# / Witness / Votes / Last block / Miss / Price / APR / Vote).
 * `params` swaps the vote-weight columns for the witness's proposed chain
 * parameters (real per-witness data from `list_witnesses().props`).
 */
export const GENERAL_GRID_TEMPLATE = '32px minmax(0,1fr) 92px 100px 68px 92px 60px 76px';
export const PARAMS_GRID_TEMPLATE = '32px minmax(0,1fr) 128px 116px 136px 92px 76px';
