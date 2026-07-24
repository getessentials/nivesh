/**
 * RTK Query layer over Supabase (docs/05 schema). Every endpoint is a thin `queryFn` around
 * supabase-js — RLS on the server is the actual authorization boundary (docs/09 §1); this layer
 * exists for caching/loading-state/invalidation, not security.
 */
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { supabase } from '@/lib/supabase';
import type {
  ProfileRow, FyExemptionInputRow, ThemeRow, EtfRow, ThemeEtfMapRow, UserChargesOverrideRow,
  TransactionRow, HoldingRow, ThemeResearchRow, MonthlyRunRow, RunAcknowledgementRow,
  RecommendationItemRow, RunEtfGateResultRow, FeedbackScoreRow, JobRunRow, EtfPriceRow, EtfNavRow,
  IndexTriRow, EtfMetricsRow, TaxConfigRow, ChargesConfigRow, NseHolidayRow, IndexRow,
  MetricsReviewQueueRow, IngestQuarantineRow,
} from '@/types/db';

/**
 * Adapts a raw supabase-js response into RTK Query's `QueryReturnValue` shape. Takes `data` as
 * `unknown` deliberately — the untyped supabase client (no generated Database type) resolves
 * `.single()`/`.maybeSingle()` result types inconsistently (sometimes including `undefined`
 * where the endpoint's declared success type doesn't), so every call site passes its expected
 * type explicitly (`unwrap<T>(...)`) instead of relying on TS to reconcile the two independently.
 */
function unwrap<T>(result: { data: unknown; error: { message: string } | null }): { data: T } | { error: { message: string } } {
  if (result.error) return { error: { message: result.error.message } };
  return { data: result.data as T };
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fakeBaseQuery<{ message: string }>(),
  tagTypes: [
    'Profile', 'FyExemptionInput', 'UserChargesOverride', 'Transaction', 'Holding', 'MonthlyRun',
    'RunAcknowledgement', 'RecommendationItem', 'FeedbackScore', 'JobRun', 'MetricsReviewQueue',
    'IngestQuarantine', 'IndexTri',
  ],
  endpoints: (builder) => ({
    // ---- Profile ----
    getProfile: builder.query<ProfileRow | null, string>({
      queryFn: async (userId) => unwrap<ProfileRow | null>(await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle()),
      providesTags: ['Profile'],
    }),
    upsertProfile: builder.mutation<ProfileRow, Partial<ProfileRow> & { user_id: string }>({
      queryFn: async (profile) => unwrap<ProfileRow>(await supabase.from('profiles').upsert(profile).select().single()),
      invalidatesTags: ['Profile'],
    }),

    // ---- FY exemption input ----
    getFyExemptionInput: builder.query<FyExemptionInputRow | null, { userId: string; fy: string }>({
      queryFn: async ({ userId, fy }) =>
        unwrap<FyExemptionInputRow | null>(await supabase.from('fy_exemption_inputs').select('*').eq('user_id', userId).eq('fy', fy).maybeSingle()),
      providesTags: ['FyExemptionInput'],
    }),
    upsertFyExemptionInput: builder.mutation<FyExemptionInputRow, FyExemptionInputRow>({
      queryFn: async (row) => unwrap<FyExemptionInputRow>(await supabase.from('fy_exemption_inputs').upsert(row).select().single()),
      invalidatesTags: ['FyExemptionInput'],
    }),

    // ---- Reference data (read-only) ----
    getThemes: builder.query<ThemeRow[], void>({
      queryFn: async () => unwrap<ThemeRow[]>(await supabase.from('themes').select('*').order('key')),
    }),
    getEtfs: builder.query<EtfRow[], void>({
      queryFn: async () => unwrap<EtfRow[]>(await supabase.from('etfs').select('*').eq('active', true).order('name')),
    }),
    getThemeEtfMap: builder.query<ThemeEtfMapRow[], void>({
      queryFn: async () => unwrap<ThemeEtfMapRow[]>(await supabase.from('theme_etf_map').select('*')),
    }),
    getIndices: builder.query<IndexRow[], void>({
      queryFn: async () => unwrap<IndexRow[]>(await supabase.from('indices').select('*')),
    }),
    getNseHolidays: builder.query<NseHolidayRow[], void>({
      queryFn: async () => unwrap<NseHolidayRow[]>(await supabase.from('nse_holidays').select('*').order('d')),
    }),
    getTaxConfig: builder.query<TaxConfigRow[], void>({
      queryFn: async () => unwrap<TaxConfigRow[]>(await supabase.from('tax_config').select('*')),
    }),
    getChargesConfig: builder.query<ChargesConfigRow[], string>({
      queryFn: async (brokerProfile) => unwrap<ChargesConfigRow[]>(await supabase.from('charges_config').select('*').eq('broker_profile', brokerProfile)),
    }),

    // ---- User charge overrides ----
    getUserChargesOverrides: builder.query<UserChargesOverrideRow[], string>({
      queryFn: async (userId) => unwrap<UserChargesOverrideRow[]>(await supabase.from('user_charges_overrides').select('*').eq('user_id', userId)),
      providesTags: ['UserChargesOverride'],
    }),
    upsertUserChargesOverride: builder.mutation<UserChargesOverrideRow, UserChargesOverrideRow>({
      queryFn: async (row) => unwrap<UserChargesOverrideRow>(await supabase.from('user_charges_overrides').upsert(row).select().single()),
      invalidatesTags: ['UserChargesOverride'],
    }),
    deleteUserChargesOverride: builder.mutation<null, { userId: string; chargeKey: string; assetClass: string }>({
      queryFn: async ({ userId, chargeKey, assetClass }) => {
        const { error } = await supabase.from('user_charges_overrides').delete()
          .eq('user_id', userId).eq('charge_key', chargeKey).eq('asset_class', assetClass);
        return error ? { error: { message: error.message } } : { data: null };
      },
      invalidatesTags: ['UserChargesOverride'],
    }),

    // ---- Transactions (lots) ----
    getTransactions: builder.query<TransactionRow[], string>({
      queryFn: async (userId) =>
        unwrap<TransactionRow[]>(await supabase.from('transactions').select('*').eq('user_id', userId).order('traded_on', { ascending: false })),
      providesTags: ['Transaction'],
    }),
    addTransaction: builder.mutation<TransactionRow, Partial<TransactionRow>>({
      queryFn: async (row) => unwrap<TransactionRow>(await supabase.from('transactions').insert(row).select().single()),
      invalidatesTags: ['Transaction', 'Holding'],
    }),
    addTransactions: builder.mutation<TransactionRow[], Partial<TransactionRow>[]>({
      queryFn: async (rows) => unwrap<TransactionRow[]>(await supabase.from('transactions').insert(rows).select()),
      invalidatesTags: ['Transaction', 'Holding'],
    }),
    deleteTransaction: builder.mutation<null, string>({
      queryFn: async (id) => {
        const { error } = await supabase.from('transactions').delete().eq('id', id);
        return error ? { error: { message: error.message } } : { data: null };
      },
      invalidatesTags: ['Transaction', 'Holding'],
    }),

    // ---- Holdings (derived view) ----
    getHoldings: builder.query<HoldingRow[], string>({
      queryFn: async (userId) => unwrap<HoldingRow[]>(await supabase.from('holdings').select('*').eq('user_id', userId)),
      providesTags: ['Holding'],
    }),

    // ---- Monthly runs ----
    getMonthlyRuns: builder.query<MonthlyRunRow[], string>({
      queryFn: async (userId) =>
        unwrap<MonthlyRunRow[]>(await supabase.from('monthly_runs').select('*').eq('user_id', userId).order('run_month', { ascending: false }).order('seq', { ascending: false })),
      providesTags: ['MonthlyRun'],
    }),
    getLatestMonthlyRun: builder.query<MonthlyRunRow | null, string>({
      queryFn: async (userId) =>
        unwrap<MonthlyRunRow | null>(await supabase.from('monthly_runs').select('*').eq('user_id', userId).order('run_month', { ascending: false }).order('seq', { ascending: false }).limit(1).maybeSingle()),
      providesTags: ['MonthlyRun'],
    }),

    // ---- Run acknowledgements ----
    getRunAcknowledgements: builder.query<RunAcknowledgementRow[], string>({
      queryFn: async (runId) => unwrap<RunAcknowledgementRow[]>(await supabase.from('run_acknowledgements').select('*').eq('run_id', runId)),
      providesTags: ['RunAcknowledgement'],
    }),
    acknowledgeRun: builder.mutation<RunAcknowledgementRow, { userId: string; runId: string; kind: 'reviewed' | 'superseded_ack' }>({
      queryFn: async ({ userId, runId, kind }) =>
        unwrap<RunAcknowledgementRow>(await supabase.from('run_acknowledgements').upsert({ user_id: userId, run_id: runId, kind }).select().single()),
      invalidatesTags: ['RunAcknowledgement'],
    }),

    // ---- Recommendation items ----
    getRecommendationItems: builder.query<RecommendationItemRow[], string>({
      queryFn: async (runId) =>
        unwrap<RecommendationItemRow[]>(await supabase.from('recommendation_items').select('*').eq('run_id', runId).order('level').order('rank')),
      providesTags: ['RecommendationItem'],
    }),
    getRunGateResults: builder.query<RunEtfGateResultRow[], string>({
      queryFn: async (runId) => unwrap<RunEtfGateResultRow[]>(await supabase.from('run_etf_gate_results').select('*').eq('run_id', runId)),
    }),

    // ---- Feedback scores ----
    getFeedbackScores: builder.query<FeedbackScoreRow[], string>({
      queryFn: async (userId) =>
        unwrap<FeedbackScoreRow[]>(await supabase.from('feedback_scores').select('*').eq('user_id', userId).order('as_of', { ascending: false })),
      providesTags: ['FeedbackScore'],
    }),

    // ---- theme_research (shared, read-only) ----
    getThemeResearch: builder.query<ThemeResearchRow | null, string>({
      queryFn: async (researchMonth) =>
        unwrap<ThemeResearchRow | null>(await supabase.from('theme_research').select('*').eq('research_month', researchMonth).maybeSingle()),
    }),

    // ---- job_runs (dashboard failure banner) ----
    getRecentJobRuns: builder.query<JobRunRow[], number | void>({
      queryFn: async (limit = 20) => unwrap<JobRunRow[]>(await supabase.from('job_runs').select('*').order('started_at', { ascending: false }).limit(limit as number)),
      providesTags: ['JobRun'],
    }),

    // ---- market data for charts ----
    getEtfPrices: builder.query<EtfPriceRow[], { etfId: number; since: string }>({
      queryFn: async ({ etfId, since }) =>
        unwrap<EtfPriceRow[]>(await supabase.from('etf_prices').select('*').eq('etf_id', etfId).gte('d', since).order('d')),
    }),
    getEtfNavs: builder.query<EtfNavRow[], { etfId: number; since: string }>({
      queryFn: async ({ etfId, since }) =>
        unwrap<EtfNavRow[]>(await supabase.from('etf_navs').select('*').eq('etf_id', etfId).gte('d', since).order('d')),
    }),
    getIndexTri: builder.query<IndexTriRow[], { indexName: string; since: string }>({
      queryFn: async ({ indexName, since }) =>
        unwrap<IndexTriRow[]>(await supabase.from('index_tri').select('*').eq('index_name', indexName).gte('d', since).order('d')),
    }),
    // Which niftyindices-sourced index names have ANY index_tri row at all — cheap presence
    // check for the Dashboard "manual step needed" banner, not the authoritative gate (that's
    // server-side, docs/10 §4). Two prior client-side-limit versions of this both broke in
    // production: PostgREST's project-level max-rows setting silently caps the response
    // regardless of any client `.limit()` value, so fetching raw rows and deduping client-side
    // is fundamentally unsound here, not just a tuning problem. Fixed by aggregating DISTINCT
    // server-side instead (migration 20260724000002) — returns only the ~9-20 distinct names
    // that will ever exist, immune to total row count.
    getIndexTriCoveredNames: builder.query<string[], void>({
      queryFn: async () => {
        const result = unwrap<string[]>(await supabase.rpc('distinct_index_tri_names'));
        return result;
      },
      providesTags: ['IndexTri'],
    }),
    // NOTE: returns ALL matching rows ordered by as_of desc, not one-per-etf_id — same "most
    // recent row per group" gap as etf_prices (see usePortfolioValuation.ts's useLatestPrices);
    // no current caller, so dedupe client-side by etf_id (keeping the first row seen) before use.
    getLatestEtfMetrics: builder.query<EtfMetricsRow[], number[]>({
      queryFn: async (etfIds) => unwrap<EtfMetricsRow[]>(await supabase.from('etf_metrics').select('*').in('etf_id', etfIds).order('as_of', { ascending: false })),
    }),

    // ---- owner-admin surfaces (read side; writes go through Edge Functions) ----
    getMetricsReviewQueue: builder.query<MetricsReviewQueueRow[], void>({
      queryFn: async () => unwrap<MetricsReviewQueueRow[]>(await supabase.from('metrics_review_queue').select('*').eq('resolved', false).order('as_of', { ascending: false })),
      providesTags: ['MetricsReviewQueue'],
    }),
    getIngestQuarantine: builder.query<IngestQuarantineRow[], void>({
      queryFn: async () => unwrap<IngestQuarantineRow[]>(await supabase.from('ingest_quarantine').select('*').eq('resolved', false).order('created_at', { ascending: false })),
      providesTags: ['IngestQuarantine'],
    }),
  }),
});

export const {
  useGetProfileQuery, useUpsertProfileMutation,
  useGetFyExemptionInputQuery, useUpsertFyExemptionInputMutation,
  useGetThemesQuery, useGetEtfsQuery, useGetThemeEtfMapQuery, useGetIndicesQuery, useGetNseHolidaysQuery,
  useGetTaxConfigQuery, useGetChargesConfigQuery,
  useGetUserChargesOverridesQuery, useUpsertUserChargesOverrideMutation, useDeleteUserChargesOverrideMutation,
  useGetTransactionsQuery, useAddTransactionMutation, useAddTransactionsMutation, useDeleteTransactionMutation,
  useGetHoldingsQuery,
  useGetMonthlyRunsQuery, useGetLatestMonthlyRunQuery,
  useGetRunAcknowledgementsQuery, useAcknowledgeRunMutation,
  useGetRecommendationItemsQuery, useGetRunGateResultsQuery,
  useGetFeedbackScoresQuery,
  useGetThemeResearchQuery,
  useGetRecentJobRunsQuery,
  useGetEtfPricesQuery, useGetEtfNavsQuery, useGetIndexTriQuery, useGetIndexTriCoveredNamesQuery, useGetLatestEtfMetricsQuery,
  useGetMetricsReviewQueueQuery, useGetIngestQuarantineQuery,
} = api;
