import type { HelpStep } from '@/components/HelpStepsDialog';

/** Shared step content — used by both the Dashboard banner and the Settings cards for the same
 *  two manual actions, so the instructions never drift between the two surfaces. */

export const TRI_UPLOAD_STEPS: HelpStep[] = [
  { text: 'Go to niftyindices.com’s historical data page:', href: 'https://www.niftyindices.com/reports/historical-data' },
  { text: 'Click the top dropdown ("Historical Index Data") and switch it to "Total returns Index Values".' },
  { text: 'Select an Index Type: Equity.' },
  { text: 'Select a Sub-Index: Broad Market Indices (for NIFTY 50 TRI — pick the matching category for other indices).' },
  { text: 'Select an Index: e.g. NIFTY 50.' },
  { text: 'Set the date range — go back at least 1 year (more history is better; the engine needs 60+ trading days minimum).' },
  { text: 'Click Submit, then click "csv format" to download.' },
  { text: 'Come back here, pick the matching index in the dropdown, choose that downloaded file, and click Upload.' },
];

export const METRICS_FORM_STEPS: HelpStep[] = [
  { text: 'For each ETF listed below, find its AMC (fund house) factsheet page — search "<ETF name> factsheet" or check the AMC’s own website.' },
  { text: 'Pull these numbers from the factsheet: AUM (₹ crore), Total Expense Ratio (%), 1-year tracking error (%), and tracking difference (1y/3y/5y if shown).' },
  { text: 'Enter them into the matching row below — AUM, TER, and TE 1y are required; TD 3y/TD 5y are optional (skip if the fund is too new to have that history).' },
  { text: 'Click "Submit N filled rows" — you don’t have to do all ETFs at once, submit whatever you’ve filled in.' },
];
