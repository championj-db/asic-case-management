import { useCallback, useEffect, useState } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider } from 'react-router';
import { api, getPersona, setPersona } from './lib/api';
import { ErrorState, SessionContext, ToastProvider, type Me } from './components/common';
import { Shell } from './components/Shell';
import { ExecutiveView, MyWorkView, PortfolioView } from './views/Home';
import { AdminView, CasesView, EntitiesView, EntityView, IntakeView, SourcesView } from './views/Directory';
import { CaseWorkspace } from './views/case/CaseWorkspace';

/** Role-based landing (SPEC 5): investigators → My Work, leads → Executive Briefing, counsel → Cases. */
function Landing({ me }: { me: Me | null }) {
  if (!me) return null;
  const to = me.persona === 'Enforcement Lead' ? '/executive' : me.persona === 'Legal Counsel' ? '/cases' : '/my-work';
  return <Navigate to={to} replace />;
}

function Root() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refreshMe = useCallback(() => {
    api
      .get<Me>('/api/me')
      .then((m) => {
        setMe(m);
        setError(null);
        if (!getPersona()) setPersona(m.userId);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(refreshMe, [refreshMe]);
  const switchPersona = useCallback(
    (id: string) => {
      setPersona(id);
      setVersion((v) => v + 1);
      refreshMe();
    },
    [refreshMe],
  );
  return (
    <SessionContext.Provider value={{ me, refreshMe, switchPersona }}>
      <ToastProvider>
        <Shell>
          {error ? <ErrorState message={`${error}. Check the Lakebase sync and app permissions.`} onRetry={refreshMe} /> : me ? <Outlet key={`${me.userId}-${version}`} context={{ me }} /> : null}
        </Shell>
      </ToastProvider>
    </SessionContext.Provider>
  );
}

function LandingRoute() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api.get<Me>('/api/me').then(setMe).catch(() => undefined);
  }, []);
  return <Landing me={me} />;
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <LandingRoute /> },
      { path: 'my-work', element: <MyWorkView /> },
      { path: 'executive', element: <ExecutiveView /> },
      { path: 'portfolio', element: <PortfolioView /> },
      { path: 'cases', element: <CasesView /> },
      { path: 'cases/:id', element: <Navigate to="overview" replace /> },
      { path: 'cases/:id/:tab', element: <CaseWorkspace /> },
      { path: 'entities', element: <EntitiesView /> },
      { path: 'entities/:id', element: <EntityView /> },
      { path: 'intake', element: <IntakeView /> },
      { path: 'admin', element: <AdminView /> },
      { path: 'sources', element: <SourcesView /> },
      { path: '*', element: <ErrorState message="This page does not exist." /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
