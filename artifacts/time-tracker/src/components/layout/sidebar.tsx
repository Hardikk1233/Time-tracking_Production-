import React from 'react';
import { Link, useLocation } from 'wouter';
import { 
  Clock, 
  LayoutDashboard, 
  Users, 
  Briefcase, 
  FolderKanban, 
  CheckSquare, 
  LogOut,
  ShieldCheck,
  CalendarDays,
  BarChart2,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useLogout, getGetMeQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const { user, isLoading } = useAuth();
  const logout = useLogout();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        // Use null (not undefined) so React Query keeps 'success' state,
        // avoiding isLoading=true and the spinner flash during transition.
        queryClient.setQueryData(getGetMeQueryKey(), null as any);
        setLocation('/login');
      }
    });
  };

  if (isLoading || !user) {
    return (
      <div className="w-64 bg-sidebar text-sidebar-foreground border-r border-sidebar-border flex flex-col h-full shrink-0">
        <div className="p-6">
          <Skeleton className="h-8 w-32 bg-sidebar-accent" />
        </div>
        <div className="px-4 flex-1 flex flex-col gap-2">
          <Skeleton className="h-10 w-full bg-sidebar-accent" />
          <Skeleton className="h-10 w-full bg-sidebar-accent" />
          <Skeleton className="h-10 w-full bg-sidebar-accent" />
        </div>
      </div>
    );
  }

  const role = user.role;
  const isAssociateOrAbove = ['associate', 'avp', 'md'].includes(role);
  const isAvpOrAbove = ['avp', 'md'].includes(role);
  const isMd = role === 'md';

  const navItems = [
    { name: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
    { name: 'Time Entries', path: '/time-entries', icon: Clock },
    ...(isAssociateOrAbove ? [
      { name: 'Approvals', path: '/approvals', icon: CheckSquare },
      { name: 'Projects', path: '/projects', icon: FolderKanban },
    ] : []),
    ...(isAvpOrAbove ? [
      { name: 'Clients', path: '/clients', icon: Briefcase },
      { name: 'Tasks', path: '/tasks', icon: CheckSquare },
      { name: 'Team', path: '/team', icon: Users },
    ] : []),
    { name: 'Reports', path: '/reports', icon: BarChart2 },
    ...(isMd ? [{ name: 'Holidays', path: '/holidays', icon: CalendarDays }] : [])
  ];

  return (
    <div className="w-64 bg-sidebar text-sidebar-foreground flex flex-col h-[100dvh] shrink-0 sticky top-0">
      <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
        <div className="flex items-center gap-2 font-bold text-lg tracking-tight">
          <Clock className="w-5 h-5 text-sidebar-primary" />
          TimeTrack
        </div>
      </div>

      <div className="flex-1 py-6 px-3 overflow-y-auto">
        <nav className="flex flex-col gap-1">
          {navItems.map((item) => (
            <Link key={item.name} href={item.path} className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium ${location.startsWith(item.path) ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'}`}>
              <item.icon className="w-4 h-4" />
              {item.name}
            </Link>
          ))}
        </nav>
      </div>

      <div className="p-4 border-t border-sidebar-border">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 rounded-full bg-sidebar-accent flex items-center justify-center font-bold text-xs uppercase">
              {user.name.substring(0, 2)}
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium truncate">{user.name}</span>
              <span className="text-xs text-sidebar-foreground/60 capitalize flex items-center gap-1">
                {role === 'md' && <ShieldCheck className="w-3 h-3 text-amber-500" />}
                {role}
              </span>
            </div>
          </div>
          <Button variant="ghost" className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent" onClick={handleLogout} disabled={logout.isPending}>
            <LogOut className="w-4 h-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </div>
    </div>
  );
}
