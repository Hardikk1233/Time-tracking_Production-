import React, { useEffect } from 'react';
import { Sidebar } from './sidebar';
import { useAuth } from '@/lib/auth';
import { useLocation } from 'wouter';

export function MainLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation('/login');
    }
  }, [isLoading, isAuthenticated, setLocation]);

  if (isLoading || !isAuthenticated) {
    return <div className="min-h-[100dvh] flex items-center justify-center bg-background"><div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin"></div></div>;
  }

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden min-w-0">
        <div className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="mx-auto max-w-6xl w-full">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
