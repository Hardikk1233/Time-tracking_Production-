import { useState } from 'react';
import { useLocation } from 'wouter';
import { MessageSquarePlus, Bug, Lightbulb, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { devSend } from '@/lib/dev-api';
import { reportError } from '@/lib/error-reporting';

/**
 * Temporary feedback button, shown on every page during the rollout.
 *
 * Sends one message and the page it was sent from. The page matters more than
 * it looks: "the dates are wrong" means something different on /reports than on
 * /time-entries, and nobody thinks to mention which they meant.
 *
 * Removed along with the rest of the rollout tooling — see routes/dev.ts.
 */

type Kind = 'bug' | 'idea' | 'other';

const KINDS: Array<{ value: Kind; label: string; icon: typeof Bug }> = [
  { value: 'bug', label: "Something's broken", icon: Bug },
  { value: 'idea', label: 'Suggestion', icon: Lightbulb },
  { value: 'other', label: 'Something else', icon: MessageCircle },
];

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('bug');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [location] = useLocation();
  const { toast } = useToast();

  async function submit() {
    const trimmed = message.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      await devSend('POST', '/feedback', {
        message: trimmed,
        kind,
        pageUrl: location,
      });
      // Cleared only on success, so a failed send does not lose what they wrote.
      setMessage('');
      setKind('bug');
      setOpen(false);
      toast({
        title: 'Thanks — that went straight through',
        description: 'Hardik gets a notification with your message.',
      });
    } catch (error) {
      reportError(error, { kind: 'feedback-submit-failed' });
      toast({
        title: 'That did not send',
        description:
          error instanceof Error ? error.message : 'Try again in a moment.',
        variant: 'destructive',
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        // Above the content but deliberately not centred or animated — this is
        // scaffolding, and it should not compete with the actual application.
        className="fixed bottom-5 right-5 z-40 shadow-lg gap-2"
        size="sm"
        data-testid="feedback-open"
      >
        <MessageSquarePlus className="h-4 w-4" />
        Feedback
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send feedback</DialogTitle>
            <DialogDescription>
              Anything odd, broken, or just annoying — this goes straight to
              Hardik. You are on <span className="font-mono">{location}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap gap-2">
            {KINDS.map(({ value, label, icon: Icon }) => (
              <Button
                key={value}
                type="button"
                variant={kind === value ? 'default' : 'outline'}
                size="sm"
                className="gap-2"
                onClick={() => setKind(value)}
              >
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            ))}
          </div>

          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="What happened, and what did you expect instead?"
            rows={6}
            maxLength={4000}
            autoFocus
            data-testid="feedback-message"
          />

          <DialogFooter className="sm:justify-between">
            <span className="text-xs text-muted-foreground self-center">
              Your name and role are attached automatically.
            </span>
            <Button
              type="button"
              onClick={submit}
              disabled={!message.trim() || sending}
              data-testid="feedback-submit"
            >
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
