import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AuthProvider } from '@/lib/auth';
import { MainLayout } from '@/components/layout/main-layout';
import NotFound from '@/pages/not-found';
import Login from '@/pages/login';
import Dashboard from '@/pages/dashboard';
import TimeEntries from '@/pages/time-entries';
import Clients from '@/pages/clients';
import ClientDetail from '@/pages/client-detail';
import Projects from '@/pages/projects';
import ProjectDetail from '@/pages/project-detail';
import Tasks from '@/pages/tasks';
import Team from '@/pages/team';
import Approvals from '@/pages/approvals';
import Holidays from '@/pages/holidays';
import Reports from '@/pages/reports';

const queryClient = new QueryClient();

function ProtectedRoutes() {
  return (
    <MainLayout>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/time-entries" component={TimeEntries} />
        <Route path="/clients" component={Clients} />
        <Route path="/clients/:id" component={ClientDetail} />
        <Route path="/projects" component={Projects} />
        <Route path="/projects/:id" component={ProjectDetail} />
        <Route path="/tasks" component={Tasks} />
        <Route path="/team" component={Team} />
        <Route path="/holidays" component={Holidays} />
        <Route path="/approvals" component={Approvals} />
        <Route path="/reports" component={Reports} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Login />} />
      <Route path="/login" component={Login} />
      <Route path="*" component={ProtectedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
