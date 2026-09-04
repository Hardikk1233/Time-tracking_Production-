import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getAuthConfig, getSignInError, isEntraEnabled, signInWithMicrosoft } from '@/lib/entra';
import { useLogin, LoginInput, getGetMeQueryKey } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useToast } from '@/hooks/use-toast';
import { Clock } from 'lucide-react';
import logo from '@/assets/logo.svg';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

/** The four-square Microsoft mark, inline to avoid pulling in an icon set. */
function MicrosoftMark() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

export default function Login() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading } = useAuth();
  const loginMutation = useLogin();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Resolved before the app mounted, so these are plain reads, not state.
  const { passwordSignIn } = getAuthConfig();
  const microsoftAvailable = isEntraEnabled();
  const [microsoftPending, setMicrosoftPending] = useState(false);

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

  // Entra reports a refusal on the return leg of the redirect, not to the
  // button handler, so without this the user lands back here with no reason.
  useEffect(() => {
    const signInError = getSignInError();
    if (signInError) {
      toast({
        variant: 'destructive',
        title: 'Microsoft sign-in failed',
        description: signInError,
      });
    }
  }, [toast]);

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

  const onMicrosoftSignIn = async () => {
    setMicrosoftPending(true);
    try {
      // Navigates this window to Microsoft and does not return. On the way
      // back, initAuth completes the handshake before the app renders and the
      // effect above sends an authenticated user to the dashboard.
      await signInWithMicrosoft();
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Microsoft sign-in failed',
        description:
          error?.errorMessage ||
          error?.message ||
          'Your account may not be assigned a TimeTrack role. Contact an administrator.',
      });
      // Only reached when the navigation never happened.
      setMicrosoftPending(false);
    }
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
            <p className="text-muted-foreground text-sm font-medium">
              {passwordSignIn
                ? 'Enter your credentials to access your terminal.'
                : 'Sign in with your work account to access your terminal.'}
            </p>
          </div>

          {microsoftAvailable && (
            <div className="space-y-6">
              <Button
                type="button"
                variant="outline"
                onClick={onMicrosoftSignIn}
                disabled={microsoftPending}
                className="w-full h-11 text-base font-semibold gap-2 active:scale-[0.98] transition-transform"
                data-testid="button-microsoft"
              >
                {microsoftPending ? (
                  <div className="w-5 h-5 border-2 border-foreground border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <>
                    <MicrosoftMark />
                    Sign in with Microsoft
                  </>
                )}
              </Button>

              {passwordSignIn && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t border-border/60" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-card px-3 text-xs uppercase tracking-wider font-bold text-muted-foreground">
                      or
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {passwordSignIn && (
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
          )}

          {!passwordSignIn && !microsoftAvailable && (
            <p className="text-sm text-destructive" data-testid="text-no-signin">
              No sign-in method is available. The server has disabled passwords but
              Microsoft sign-in is not configured.
            </p>
          )}

          <div className="pt-8 text-center">
            <p className="text-xs text-muted-foreground">
              By signing in, you acknowledge the{' '}
              <Link
                href="/time-policy"
                className="underline hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded"
              >
                Firm's Time Policy
              </Link>
              .
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
        
        {/* Brand lockup, held to the top by mb-auto while the parent keeps the
            headline at the bottom.

            The wordmark is white ink on transparency, so it belongs on this pane
            and would vanish on the light one. It is a 246x34 raster whose strokes
            are roughly half anti-aliasing, so it is rendered *below* its source
            height: downscaling averages those soft edges into something that
            reads sharp, where any enlargement puts the mush on display. The rule
            beneath gives the restrained size a reason, so it reads as deliberate
            rather than as an image that failed to load properly. */}
        <div className="relative z-10 mb-auto flex flex-col items-start gap-3.5">
          {/* items-start and self-start both matter: a flex column stretches its
              children across the cross axis by default, which widened the mark
              to the whole pane and threw away its 7.24:1 ratio.

              Vector now, so the height is a free choice rather than a ceiling —
              the export shipped without a viewBox, which is added in the asset
              so this scales instead of cropping. */}
          <img
            src={logo}
            alt="Tristone Strategic Partners"
            width={246}
            height={34}
            style={{ height: '30px', width: 'auto', maxWidth: 'none' }}
            className="block self-start"
          />
          <span className="h-px w-8 bg-sidebar-foreground/25" />
        </div>

        <div className="relative z-10 max-w-md">
          <div className="h-1 w-12 bg-primary mb-6"></div>
          <h2 className="text-4xl font-serif tracking-tight text-sidebar-foreground mb-4">Precision in every minute.</h2>
          <p className="text-sidebar-foreground/70 font-mono text-sm leading-relaxed">
            UPTIME // 99.99%<br/>
            STATUS // SECURE
          </p>
        </div>
      </div>
    </div>
  );
}
