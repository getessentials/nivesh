import { useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useAppDispatch, useAppSelector } from '@/store/hooks';
import { sessionResolved } from '@/store/authSlice';

/** Resolves the initial Supabase session once, then keeps the store in sync with sign-in/out
 *  events. Call this ONCE near the app root (App.tsx). */
export function useAuthListener(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => dispatch(sessionResolved(data.session)));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      dispatch(sessionResolved(session));
    });
    return () => subscription.subscription.unsubscribe();
  }, [dispatch]);
}

export function useAuth() {
  return useAppSelector((state) => state.auth);
}
