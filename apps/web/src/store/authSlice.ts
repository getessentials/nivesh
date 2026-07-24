import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Session } from '@supabase/supabase-js';

interface AuthState {
  session: Session | null;
  /** null = still resolving the initial session from Supabase on page load. */
  initialized: boolean;
}

const initialState: AuthState = { session: null, initialized: false };

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    sessionResolved(state, action: PayloadAction<Session | null>) {
      state.session = action.payload;
      state.initialized = true;
    },
  },
});

export const { sessionResolved } = authSlice.actions;
export default authSlice.reducer;
