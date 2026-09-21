import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useCompleteTour, getGetMeQueryKey } from '@workspace/api-client-react';
import { stepsFor, type TourStep } from '@/lib/tour-steps';
import { Compass, X } from 'lucide-react';

/**
 * The guided walkthrough, and the button that brings it back.
 *
 * Opens by itself the first time somebody signs in — the server sends
 * `tourCompletedAt: null` until they have seen it — and afterwards only when
 * they ask for it. Finishing and dismissing both count as seen, because
 * somebody who closed it deliberately should not be shown it again tomorrow.
 *
 * Steps are data in lib/tour-steps and differ per rank, so nothing here
 * points at a control the viewer's account would refuse. Targets are found by
 * `data-tour` attributes rather than CSS classes, so restyling a button cannot
 * silently break the tour.
 */

const GAP = 14;
const PAD = 6;
const CARD_W = 300;

type Box = { top: number; left: number; width: number; height: number };

export function ProductTour() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const complete = useCompleteTour();

  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Box | null>(null);
  const [card, setCard] = useState<{ top: number; left: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);

  const steps: TourStep[] = user ? stepsFor(user.role, user.name) : [];
  const step: TourStep | undefined = steps[index];

  // First sign-in opens it once. The ref guards against a re-render starting
  // it again after the person has dismissed it in this same session.
  useEffect(() => {
    if (!user || autoStarted.current) return;
    if (user.tourCompletedAt == null) {
      autoStarted.current = true;
      setIndex(0);
      setOpen(true);
    } else {
      autoStarted.current = true;
    }
  }, [user]);

  // Each step declares the page it belongs on.
  useEffect(() => {
    if (!open || !step) return;
    if (location !== step.path) setLocation(step.path);
  }, [open, step, location, setLocation]);

  const measure = useCallback(() => {
    if (!open || !step) return;

    if (!step.anchor) {
      setSpot(null);
      setCard(null);
      return;
    }

    const target = document.querySelector<HTMLElement>(`[data-tour="${step.anchor}"]`);
    if (!target) {
      // The page may not have rendered this control yet, or the rank may not
      // have it at all. Centre the card rather than point at nothing.
      setSpot(null);
      setCard(null);
      return;
    }

    const r = target.getBoundingClientRect();
    const box: Box = {
      top: r.top - PAD,
      left: r.left - PAD,
      width: r.width + PAD * 2,
      height: r.height + PAD * 2,
    };
    setSpot(box);

    const ch = cardRef.current?.offsetHeight ?? 170;
    let top: number;
    let left: number;
    switch (step.side) {
      case 'left':
        left = box.left - CARD_W - GAP;
        top = box.top + box.height / 2 - ch / 2;
        break;
      case 'top':
        left = box.left + box.width / 2 - CARD_W / 2;
        top = box.top - ch - GAP;
        break;
      case 'bottom':
        left = box.left + box.width / 2 - CARD_W / 2;
        top = box.top + box.height + GAP;
        break;
      default:
        left = box.left + box.width + GAP;
        top = box.top + box.height / 2 - ch / 2;
    }
    setCard({
      left: Math.max(12, Math.min(left, window.innerWidth - CARD_W - 12)),
      top: Math.max(12, Math.min(top, window.innerHeight - ch - 12)),
    });
  }, [open, step]);

  // Measure after paint, and again shortly after: a step that navigates lands
  // before the destination page has rendered its controls.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const t = window.setTimeout(measure, 160);
    return () => window.clearTimeout(t);
  }, [measure, open, location, index]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure, open]);

  const markSeen = useCallback(() => {
    // Only worth a round trip the first time. Replays do not clear the flag,
    // so re-recording it every time would be a write that changes nothing.
    if (user?.tourCompletedAt != null) return;
    complete.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
    });
  }, [complete, queryClient, user]);

  const finish = useCallback(() => {
    setOpen(false);
    setIndex(0);
    markSeen();
  }, [markSeen]);

  const next = useCallback(() => {
    if (index >= steps.length - 1) finish();
    else setIndex((i) => i + 1);
  }, [index, steps.length, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, back, finish]);

  if (!user) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setIndex(0); setOpen(true); }}
        className="fixed bottom-[4.5rem] right-5 z-40 flex items-center gap-2 rounded-full border border-border bg-background px-4 py-2 text-sm font-semibold text-primary shadow-lg transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label="Take the guided tour"
      >
        <Compass className="h-4 w-4" />
        Take the tour
      </button>
    );
  }

  if (!step) return null;

  const centred = !spot || !card;
  const total = steps.length;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* One element does both jobs: the ring around the control, and the
          dimming everywhere else via an enormous spread shadow. */}
      {spot ? (
        <div
          className="pointer-events-none absolute rounded-lg transition-all duration-300 ease-out motion-reduce:transition-none"
          style={{
            top: spot.top,
            left: spot.left,
            width: spot.width,
            height: spot.height,
            boxShadow: '0 0 0 3px hsl(var(--primary) / 0.85), 0 0 0 9999px rgba(9, 14, 22, 0.55)',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[rgba(9,14,22,0.55)]" />
      )}

      <div
        ref={cardRef}
        className="absolute w-[300px] rounded-xl bg-primary p-4 text-primary-foreground shadow-2xl transition-all duration-300 ease-out motion-reduce:transition-none"
        style={
          centred
            ? { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 360 }
            : { left: card!.left, top: card!.top }
        }
      >
        <button
          type="button"
          onClick={finish}
          aria-label="Skip the tour"
          className="absolute right-2.5 top-2.5 rounded p-1 text-primary-foreground/70 transition-colors hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/60"
        >
          <X className="h-3.5 w-3.5" />
        </button>

        <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-primary-foreground/70">
          {step.kicker}
        </p>
        <h4 className="mb-1.5 pr-5 text-[15px] font-bold leading-snug tracking-tight">{step.title}</h4>
        <p className="text-[13px] leading-relaxed text-primary-foreground/85">{step.body}</p>

        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-primary-foreground/20 pt-3">
          <span className="font-mono text-[11px] tabular-nums text-primary-foreground/70">
            {index + 1} / {total}
          </span>
          <span className="flex gap-1.5">
            {index > 0 && (
              <button
                type="button"
                onClick={back}
                className="rounded-md border border-primary-foreground/30 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-primary-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/60"
              >
                Back
              </button>
            )}
            <button
              type="button"
              onClick={next}
              className="rounded-md bg-primary-foreground px-3 py-1 text-xs font-semibold text-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-foreground/60"
            >
              {index === total - 1 ? 'Finish' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
