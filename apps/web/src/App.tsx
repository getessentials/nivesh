import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { useAuthListener, useAuth } from '@/hooks/useAuth';
import { useGetProfileQuery } from '@/store/api';
import AppShell from '@/components/layout/AppShell';
import LoginPage from '@/routes/LoginPage';
import OnboardingPage from '@/routes/OnboardingPage';
import DashboardPage from '@/routes/DashboardPage';
import PlanPage from '@/routes/PlanPage';
import PortfolioPage from '@/routes/PortfolioPage';
import PerformancePage from '@/routes/PerformancePage';
import TaxesPage from '@/routes/TaxesPage';
import SettingsPage from '@/routes/SettingsPage';

function FullPageSpinner() {
  return <div className="min-h-screen flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
}

/** Gates every authenticated route: resolves the session first, then (once signed in) whether
 *  onboarding is complete — a user with no `profiles` row is sent to /onboarding regardless of
 *  which URL they landed on (docs/01 §3.1). */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, initialized } = useAuth();
  if (!initialized) return <FullPageSpinner />;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireOnboarded({ children }: { children: React.ReactNode }) {
  const { session } = useAuth();
  const { data: profile, isLoading } = useGetProfileQuery(session!.user.id);
  if (isLoading) return <FullPageSpinner />;
  if (!profile) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export default function App() {
  useAuthListener();

  return (
    <TooltipProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/onboarding"
            element={
              <RequireAuth>
                <OnboardingPage />
              </RequireAuth>
            }
          />
          <Route
            element={
              <RequireAuth>
                <RequireOnboarded>
                  <AppShell />
                </RequireOnboarded>
              </RequireAuth>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/plan/:runId" element={<PlanPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/performance" element={<PerformancePage />} />
            <Route path="/taxes" element={<TaxesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </TooltipProvider>
  );
}
