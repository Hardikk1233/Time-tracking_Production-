import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, Trash2, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { devGet, devSend, type AppEvent, type FeedbackItem } from '@/lib/dev-api';

/**
 * Temporary console for the rollout: what broke, and what people said about it.
 *
 * Server-gated by DEV_CONSOLE_EMAILS — the endpoints answer 404 to anyone not
 * on the list, so this page being reachable in the bundle grants nothing. It is
 * unlinked from the sidebar for the same reason it is temporary: it is not part
 * of the product.
 */

interface Summary {
  unreadFeedback: number;
  latestEventId: number | null;
}

function timeAgo(iso: string): string {
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function NotAvailable() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <AlertCircle className="h-10 w-10 text-muted-foreground mb-4" />
      <h2 className="text-lg font-semibold">Not available</h2>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        This console is limited to the accounts listed in{' '}
        <span className="font-mono">DEV_CONSOLE_EMAILS</span>, and is switched
        off entirely when that variable is unset.
      </p>
    </div>
  );
}

export default function DevConsole() {
  const [source, setSource] = useState<'all' | 'client' | 'server'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const summary = useQuery({
    queryKey: ['dev', 'summary'],
    queryFn: () => devGet<Summary>('/dev/summary'),
    retry: false,
    // Polled so feedback arriving while the page is open shows up on its own.
    refetchInterval: 30_000,
  });

  const feedback = useQuery({
    queryKey: ['dev', 'feedback'],
    queryFn: () => devGet<{ feedback: FeedbackItem[] }>('/dev/feedback'),
    retry: false,
  });

  const events = useQuery({
    queryKey: ['dev', 'events', source],
    queryFn: () =>
      devGet<{ events: AppEvent[] }>(
        source === 'all' ? '/dev/events' : `/dev/events?source=${source}`,
      ),
    retry: false,
  });

  const markRead = useMutation({
    mutationFn: (id: number) => devSend('POST', `/dev/feedback/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dev'] });
    },
  });

  const clearEvents = useMutation({
    mutationFn: () => devSend('DELETE', '/dev/events'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dev'] });
      toast({ title: 'Event log cleared' });
    },
  });

  // A 404 here means "not allowlisted" rather than "broken" — the endpoints
  // answer that way on purpose, so say so plainly instead of showing an error.
  if (summary.isError) return <NotAvailable />;

  const unread = summary.data?.unreadFeedback ?? 0;
  const feedbackItems = feedback.data?.feedback ?? [];
  const eventItems = events.data?.events ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dev console</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Temporary. Errors captured from both sides of the app, and feedback
            from whoever is testing.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['dev'] })}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <Tabs defaultValue="feedback">
        <TabsList>
          <TabsTrigger value="feedback" className="gap-2">
            Feedback
            {unread > 0 && <Badge variant="default">{unread}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="errors" className="gap-2">
            Errors
            {eventItems.length > 0 && (
              <Badge variant="secondary">{eventItems.length}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="feedback" className="space-y-3 mt-4">
          {feedbackItems.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Nothing yet.
            </p>
          )}

          {feedbackItems.map((item) => (
            <Card
              key={item.id}
              className={item.status === 'new' ? 'border-primary/40' : undefined}
            >
              <CardContent className="pt-6 space-y-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{item.userName}</span>
                      <Badge variant="outline">{item.userRole}</Badge>
                      <Badge
                        variant={item.kind === 'bug' ? 'destructive' : 'secondary'}
                      >
                        {item.kind}
                      </Badge>
                      {item.status === 'new' && <Badge>new</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {item.userEmail} · {timeAgo(item.createdAt)}
                      {item.pageUrl ? ` · ${item.pageUrl}` : ''}
                    </p>
                  </div>

                  {item.status === 'new' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2"
                      disabled={markRead.isPending}
                      onClick={() => markRead.mutate(item.id)}
                    >
                      <Check className="h-4 w-4" />
                      Mark read
                    </Button>
                  )}
                </div>

                <p className="text-sm whitespace-pre-wrap">{item.message}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="errors" className="space-y-3 mt-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex gap-2">
              {(['all', 'client', 'server'] as const).map((value) => (
                <Button
                  key={value}
                  variant={source === value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSource(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={clearEvents.isPending || eventItems.length === 0}
              onClick={() => clearEvents.mutate()}
            >
              <Trash2 className="h-4 w-4" />
              Clear
            </Button>
          </div>

          {eventItems.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No errors captured.
            </p>
          )}

          {eventItems.map((event) => (
            <Card key={event.id}>
              <CardContent className="pt-6 space-y-2">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant={event.source === 'server' ? 'destructive' : 'secondary'}
                    >
                      {event.source}
                    </Badge>
                    {event.method && (
                      <Badge variant="outline">
                        {event.method} {event.statusCode ?? ''}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(event.occurredAt)}
                    </span>
                  </div>
                  {event.stack && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setExpanded(expanded === event.id ? null : event.id)
                      }
                    >
                      {expanded === event.id ? 'Hide' : 'Stack'}
                    </Button>
                  )}
                </div>

                <p className="text-sm font-medium break-words">{event.message}</p>

                <p className="text-xs text-muted-foreground break-words">
                  {[event.url, event.userEmail ?? 'anonymous']
                    .filter(Boolean)
                    .join(' · ')}
                </p>

                {expanded === event.id && event.stack && (
                  // Long stacks scroll inside their own box rather than
                  // stretching the page sideways.
                  <pre className="text-xs bg-muted rounded-md p-3 overflow-x-auto whitespace-pre">
                    {event.stack}
                  </pre>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
