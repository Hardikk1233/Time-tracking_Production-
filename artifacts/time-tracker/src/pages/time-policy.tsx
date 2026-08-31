import React from 'react';
import { Link } from 'wouter';
import { Clock, ArrowLeft } from 'lucide-react';

/**
 * The time policy, reachable without signing in — it is linked from the login
 * screen, where nobody has a session yet.
 *
 * Everything under "How TimeTrack works" describes what the application
 * actually enforces, so it can be checked against the code rather than taken on
 * trust. The firm's own expectations - deadlines, what counts as billable - are
 * marked as outstanding rather than invented here: they are management's to
 * state, and a policy page that guesses at them is worse than one that admits
 * the gap.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  );
}

function Rule({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row gap-1 sm:gap-4 py-2.5 border-b border-border/50 last:border-b-0">
      <span className="sm:w-52 shrink-0 font-mono text-[11px] uppercase tracking-wider text-foreground/70 pt-0.5">
        {label}
      </span>
      <span className="flex-1">{children}</span>
    </div>
  );
}

export default function TimePolicy() {
  return (
    <div className="min-h-[100dvh] w-full bg-background">
      <div className="mx-auto max-w-3xl px-6 py-12 sm:px-8 sm:py-16 flex flex-col gap-10">

        <div className="flex flex-col gap-6">
          <Link href="/login">
            <button className="self-start inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              Back to sign in
            </button>
          </Link>

          <div className="flex items-center gap-2 text-primary font-bold text-xl tracking-tight">
            <Clock className="w-5 h-5" />
            TimeTrack
          </div>

          <div className="flex flex-col gap-3">
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-foreground">
              Time Policy
            </h1>
            <p className="text-muted-foreground leading-relaxed">
              How time is recorded, reviewed and locked in TimeTrack, and what the
              application enforces on its own.
            </p>
          </div>
        </div>

        <Section title="Recording time">
          <div className="flex flex-col">
            <Rule label="What an entry needs">
              A date, a number of hours, and a task. Client work also carries the
              project it belongs to.
            </Rule>
            <Rule label="Where you can log">
              To projects you have been assigned to. AVPs and MDs may log against any
              project without an explicit assignment.
            </Rule>
            <Rule label="A standard day">
              Eight hours. Capacity and utilisation figures throughout the app are
              calculated from that, and one FTE is treated as 40 hours a week and 160
              a month.
            </Rule>
            <Rule label="Editing your own">
              Freely, until the entry is approved.
            </Rule>
          </div>
        </Section>

        <Section title="Review and approval">
          <div className="flex flex-col">
            <Rule label="Who reviews">
              An associate approves entries on projects they are assigned to. An AVP
              approves across clients they are assigned to. An MD may approve anything.
              Analysts do not approve time.
            </Rule>
            <Rule label="Internal time">
              An entry carrying no project cannot be attributed to a client, and only
              an MD may act on it.
            </Rule>
            <Rule label="Three states">
              Every entry is pending, approved or rejected. It starts pending.
            </Rule>
            <Rule label="Billable split">
              An associate or above may record how much of an entry is billable, any
              amount from none of it up to the full hours. This is fixed at approval
              and cannot be changed afterwards.
            </Rule>
          </div>
        </Section>

        <Section title="Once approved">
          <div className="flex flex-col">
            <Rule label="The entry locks">
              An approved entry can no longer be edited, and its billable split is
              settled. This is what makes an approved timesheet something the firm can
              bill from.
            </Rule>
            <Rule label="Corrections">
              Only an MD can reopen an approved entry. Doing so is recorded, so a
              correction is visible rather than silent.
            </Rule>
            <Rule label="Deletions">
              You may delete your own entries. Deleting somebody else&rsquo;s is
              restricted to an MD.
            </Rule>
            <Rule label="Rejected time">
              Rejected hours do not count against a client&rsquo;s purchased hours. The
              work was not accepted, so it is not billed.
            </Rule>
          </div>
        </Section>

        <Section title="What is kept">
          <p>
            Every entry carries a history: creation, each edit, approval, rejection,
            reopening and deletion, together with who did it and when. The record is
            append-only, so the sequence of events on a timesheet can always be
            reconstructed.
          </p>
        </Section>

        <Section title="How clients are billed">
          <div className="flex flex-col">
            <Rule label="FTE">
              The client pays for dedicated capacity, measured as a share of full-time
              people rather than against a fixed pool of hours.
            </Rule>
            <Rule label="Block of hours">
              The client buys hours in advance and logged work draws them down. Hours
              still awaiting approval are counted, because the work has been done — a
              balance that ignored them would read high for as long as review lags.
            </Rule>
            <Rule label="Product">
              The client buys defined deliverables, each allocated to whoever produces
              it.
            </Rule>
          </div>
        </Section>

        <Section title="Access">
          <div className="flex flex-col">
            <Rule label="Signing in">
              With your Tristone Microsoft work account. There is no separate TimeTrack
              password.
            </Rule>
            <Rule label="What you can see and do">
              Determined by your role, which comes from your Microsoft group
              membership. It is not editable inside TimeTrack, and a change takes
              effect the next time you sign in.
            </Rule>
            <Rule label="Leave and holidays">
              You record your own leave. Public holidays are maintained by an MD and
              are excluded from expected working hours.
            </Rule>
          </div>
        </Section>

        <Section title="Still to be confirmed">
          <p>
            The points below are the firm&rsquo;s to set, not the system&rsquo;s, and
            are not yet enforced anywhere in TimeTrack:
          </p>
          <ul className="flex flex-col gap-2 pl-5 list-disc">
            <li>When timesheets are due, and by when they must be approved</li>
            <li>Whether a minimum number of hours per day or week is expected</li>
            <li>Which activities the firm counts as billable</li>
            <li>How far back an entry may be logged or amended</li>
            <li>Who to approach about a disputed rejection</li>
          </ul>
          <p className="text-xs">
            Until these are agreed, treat this page as a description of the
            application rather than a statement of firm policy.
          </p>
        </Section>

        <div className="border-t border-border pt-6 flex flex-col sm:flex-row justify-between gap-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          <span>Tristone Strategic Partners</span>
          <span>Describes TimeTrack as deployed</span>
        </div>

      </div>
    </div>
  );
}
