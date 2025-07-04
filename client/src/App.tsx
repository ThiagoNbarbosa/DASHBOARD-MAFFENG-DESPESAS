import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "./lib/auth";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Despesas from "@/pages/despesas";
import Results from "@/pages/results";
import Faturamento from "@/pages/faturamento";
import Relatorios from "@/pages/relatorios";
import Final from "@/pages/final";
import NotFound from "@/pages/not-found";

function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useQuery({
    queryKey: ['/api/auth/me'],
    queryFn: authApi.getCurrentUser,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Carregando...</div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/despesas" component={Despesas} />
      <Route path="/faturamento" component={Faturamento} />
      <Route path="/relatorios" component={Relatorios} />
      <Route path="/results" component={Results} />
      <Route path="/final" component={Final} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthProvider>
          <Router />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
