import React, { useEffect } from 'react';
import { useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useLogin, LoginInput, getGetMeQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { Clock } from 'lucide-react';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export default function Login() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const loginMutation = useLogin();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  useEffect(() => {
    if (isAuthenticated) {
      setLocation('/dashboard');
    }
  }, [isAuthenticated, setLocation]);

  if (isLoading || isAuthenticated) {
    return null;
  }

  const onSubmit = (data: z.infer<typeof loginSchema>) => {
    loginMutation.mutate({ data }, {
      onSuccess: (user) => {
        queryClient.setQueryData(getGetMeQueryKey(), user);
        setLocation('/dashboard');
      },
      onError: (error: any) => {
        toast({
          variant: 'destructive',
          title: 'Login failed',
          description: error.error || 'Please check your credentials and try again.',
        });
      }
    });
  };

  return (
    <div className="min-h-[100dvh] w-full flex bg-background">
      {/* Left Pane - Form */}
      <div className="w-full lg:w-1/2 flex items-center justify-center p-8 sm:p-12 relative z-10 bg-card border-r border-border shadow-2xl">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-primary font-bold text-2xl tracking-tight mb-4">
              <Clock className="w-6 h-6" />
              TimeTrack
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Sign In</h1>
            <p className="text-muted-foreground text-sm font-medium">Enter your credentials to access your terminal.</p>
          </div>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Email</FormLabel>
                      <FormControl>
                        <Input 
                          placeholder="professional@firm.com" 
                          {...field} 
                          className="h-11 border-border/50 bg-background/50 focus-visible:ring-primary/20"
                          data-testid="input-email"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="text-xs uppercase tracking-wider font-bold text-muted-foreground">Password</FormLabel>
                      <FormControl>
                        <Input 
                          type="password" 
                          placeholder="••••••••" 
                          {...field} 
                          className="h-11 border-border/50 bg-background/50 focus-visible:ring-primary/20"
                          data-testid="input-password"
                        />
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </div>

              <Button 
                type="submit" 
                className="w-full h-11 text-base font-semibold shadow-md active:scale-[0.98] transition-transform"
                disabled={loginMutation.isPending}
                data-testid="button-submit"
              >
                {loginMutation.isPending ? (
                  <div className="w-5 h-5 border-2 border-primary-foreground border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  'Access Terminal'
                )}
              </Button>
            </form>
          </Form>

          <div className="pt-8 text-center">
            <p className="text-xs text-muted-foreground">
              By signing in, you acknowledge the <a href="#" className="underline hover:text-foreground">Firm's Time Policy</a>.
            </p>
          </div>
        </div>
      </div>

      {/* Right Pane - Visual */}
      <div className="hidden lg:flex w-1/2 bg-sidebar relative overflow-hidden flex-col justify-end p-12">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-sidebar-accent/50 via-sidebar to-sidebar opacity-80" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] mix-blend-overlay pointer-events-none"></div>
        
        {/* Abstract Data Viz Decoration */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] border border-sidebar-border/30 rounded-full flex items-center justify-center opacity-20">
          <div className="w-[600px] h-[600px] border border-sidebar-border/40 rounded-full flex items-center justify-center">
            <div className="w-[400px] h-[400px] border border-sidebar-border/50 rounded-full"></div>
          </div>
        </div>
        
        <div className="relative z-10 max-w-md">
          <div className="h-1 w-12 bg-primary mb-6"></div>
          <h2 className="text-4xl font-serif tracking-tight text-sidebar-foreground mb-4">Precision in every minute.</h2>
          <p className="text-sidebar-foreground/70 font-mono text-sm leading-relaxed">
            SYSTEM // TERMINAL ACCESS GRANTED<br/>
            UPTIME // 99.99%<br/>
            STATUS // SECURE
          </p>
        </div>
      </div>
    </div>
  );
}
