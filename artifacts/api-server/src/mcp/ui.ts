/**
 * HTML views rendered inside Claude for the tools that return one.
 *
 * These run in a sandboxed iframe with no network access, so everything the
 * view needs is inlined and the data arrives through the MCP Apps bridge rather
 * than being fetched. Styling follows the application: navy, restrained cards,
 * mono micro-labels, and semantic colour reserved for a state that needs acting
 * on rather than used for decoration.
 */

const SHELL_STYLES = `
  :root {
    color-scheme: light dark;
    --ground: #f6f6f3; --surface: #fff; --surface-2: #f0efea;
    --ink: #0f1620; --ink-2: #4a5260; --ink-3: #7c8494;
    --navy: #1c3557; --rule: #dcdbd4; --rule-soft: #e9e8e2;
    --navy-soft: #8296b0;
    --amber: #a16207; --crimson: #a4232c; --green: #1f6b4a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0e1218; --surface: #161b23; --surface-2: #1c222b;
      --ink: #e7e8e4; --ink-2: #a4abb8; --ink-3: #737b88;
      --navy: #8fb0dd; --rule: #2a313c; --rule-soft: #222932;
      --navy-soft: #55667f;
      --amber: #e0a33f; --crimson: #e2707a; --green: #6cc39b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; background: var(--ground); color: var(--ink);
    font: 14px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .k {
    font: 500 10px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3);
  }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 14px; letter-spacing: -.01em; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .tile { background: var(--surface); border: 1px solid var(--rule); padding: 11px 13px; }
  .v {
    font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums; margin-top: 3px;
  }
  .v.warn { color: var(--amber); } .v.bad { color: var(--crimson); }
  .v.ok { color: var(--green); } .v.mut { color: var(--ink-3); }
  table { border-collapse: collapse; width: 100%; margin-top: 14px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--rule-soft); }
  th {
    font: 500 10px/1.4 ui-monospace, monospace; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink-3); border-bottom: 1px solid var(--rule);
  }
  td.num {
    text-align: right;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums;
  }
  .meter { height: 6px; background: var(--surface-2); border: 1px solid var(--rule-soft); overflow: hidden; margin-top: 10px; }
  .meter > span { display: block; height: 100%; background: var(--navy); }
  .meter > span.warn { background: var(--amber); }
  .meter > span.bad { background: var(--crimson); }
  .empty {
    border: 1px dashed var(--rule); padding: 18px; text-align: center;
    font: 500 11px/1.4 ui-monospace, monospace; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink-3);
  }
  .note { margin-top: 10px; font-size: 12px; color: var(--ink-3); }

  /* Horizontal bars: the names are long, so they read better down the side
     than rotated under a column. */
  .chart { margin-top: 16px; }
  .bar-row { display: grid; grid-template-columns: minmax(0, 7.5rem) 1fr auto; align-items: center; gap: 10px; margin-bottom: 7px; }
  .bar-name { font-size: 12px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The track is the full scale, so every bar is read against the same width. */
  .bar-track { position: relative; height: 18px; background: var(--surface); border-bottom: 1px solid var(--rule-soft); }
  .bar { position: absolute; inset: 0 auto 0 0; display: flex; height: 18px; }
  /* 2px of surface between the two segments - the gap separates them, not a
     border, which would add ink that is not data. */
  .seg { height: 100%; }
  .seg.billable { background: var(--navy); }
  .seg.nonbill { background: var(--navy-soft); margin-left: 2px; border-radius: 0 4px 4px 0; }
  .seg.billable.capped { border-radius: 0 4px 4px 0; }
  .bar-value {
    font: 600 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-variant-numeric: tabular-nums; color: var(--ink); white-space: nowrap;
  }
  .legend { display: flex; gap: 14px; margin: 12px 0 2px; }
  .legend span { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-2); }
  .legend i { width: 10px; height: 10px; display: inline-block; }
  .legend i.billable { background: var(--navy); }
  .legend i.nonbill { background: var(--navy-soft); }
  .pill {
    display: inline-block; padding: 1px 6px; border: 1px solid var(--rule);
    font: 500 10px/1.5 ui-monospace, monospace; text-transform: uppercase;
    letter-spacing: .07em; color: var(--ink-3);
  }
  .pill.bad { color: var(--crimson); border-color: var(--crimson); }
  .pill.warn { color: var(--amber); border-color: var(--amber); }
`;

/**
 * Wraps a view body in the shell.
 *
 * The data is serialised into the document rather than fetched, and read back
 * out of a JSON script tag so no value is ever interpolated into executable
 * positions.
 */
export function renderView(
  title: string,
  data: unknown,
  bodyScript: string,
): string {
  const json = JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${SHELL_STYLES}</style>
</head>
<body>
<div id="root"></div>
<script type="application/json" id="data">${json}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var root = document.getElementById("root");
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function h(n) { return (Math.round(Number(n || 0) * 10) / 10).toFixed(1) + "h"; }
  ${bodyScript}
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Hours logged against capacity for a period.
 *
 * Utilisation is billable over capacity, and capacity already has holidays and
 * booked leave taken out of it — so a figure over 100 means more billable time
 * than there were working hours to give, which is worth seeing rather than
 * quietly clamping.
 */
export const SUMMARY_VIEW = `
  var util = Number(data.utilization || 0);
  var utilClass = util > 100 ? "bad" : util >= 85 ? "ok" : util >= 60 ? "" : "warn";
  var tiles = [
    ["Logged", h(data.totalHours), ""],
    ["Billable", h(data.billableHours), ""],
    ["Capacity", h(data.capacityHours), "mut"],
    ["Utilisation", (Math.round(util * 10) / 10) + "%", utilClass]
  ];
  var html = "<h1>" + esc(data.label || "Time logged") + "</h1><div class='grid'>";
  tiles.forEach(function (t) {
    html += "<div class='tile'><div class='k'>" + esc(t[0]) + "</div>" +
            "<div class='v " + t[2] + "'>" + esc(t[1]) + "</div></div>";
  });
  html += "</div>";

  var pct = Math.min(100, Math.max(0, util));
  html += "<div class='meter'><span class='" +
          (util > 100 ? "bad" : util < 60 ? "warn" : "") +
          "' style='width:" + pct + "%'></span></div>";

  var bits = [];
  if (data.pendingApprovalCount) bits.push(data.pendingApprovalCount + " entries awaiting approval");
  if (data.leaveDays) bits.push(data.leaveDays + " leave days");
  if (data.effectiveWorkingDays != null) bits.push(data.effectiveWorkingDays + " working days after holidays and leave");
  if (bits.length) html += "<div class='note'>" + esc(bits.join(" · ")) + "</div>";

  root.innerHTML = html;
`;

/** Client hour-block balances, overruns first. */
export const BALANCES_VIEW = `
  var html = "<h1>" + esc(data.label || "Hour blocks") + "</h1>";
  if (!data.clients || !data.clients.length) {
    root.innerHTML = html + "<div class='empty'>No clients on a block of hours</div>";
    return;
  }
  html += "<table><thead><tr><th>Client</th>" +
          "<th style='text-align:right'>Bought</th>" +
          "<th style='text-align:right'>Used</th>" +
          "<th style='text-align:right'>Left</th>" +
          "<th>Status</th></tr></thead><tbody>";
  data.clients.forEach(function (c) {
    var over = c.remainingHours < 0;
    var low = !over && c.purchasedHours > 0 && c.remainingHours <= c.purchasedHours * 0.1;
    var cls = over ? "bad" : low ? "warn" : "";
    var label = over ? "Overrun" : low ? "Low" : "OK";
    html += "<tr><td>" + esc(c.clientName) + "</td>" +
            "<td class='num'>" + esc(h(c.purchasedHours)) + "</td>" +
            "<td class='num'>" + esc(h(c.consumedHours)) + "</td>" +
            "<td class='num' style='font-weight:600'>" + esc(h(c.remainingHours)) + "</td>" +
            "<td><span class='pill " + cls + "'>" + label + "</span></td></tr>";
  });
  html += "</tbody></table>";
  html += "<div class='note'>Hours awaiting approval already draw the balance down. Rejected time does not.</div>";
  root.innerHTML = html;
`;

/** What is sitting unapproved, oldest first. */
export const APPROVALS_VIEW = `
  var html = "<h1>Awaiting approval</h1>";
  if (!data.entries || !data.entries.length) {
    root.innerHTML = html + "<div class='empty'>Nothing awaiting approval</div>";
    return;
  }
  html += "<div class='grid'>" +
          "<div class='tile'><div class='k'>Entries</div><div class='v warn'>" +
          esc(data.entries.length) + "</div></div>" +
          "<div class='tile'><div class='k'>Hours</div><div class='v warn'>" +
          esc(h(data.totalHours)) + "</div></div>" +
          "<div class='tile'><div class='k'>Oldest</div><div class='v mut'>" +
          esc(data.oldestDays != null ? data.oldestDays + "d" : "-") + "</div></div></div>";
  html += "<table><thead><tr><th>Person</th><th>Client</th><th>Date</th>" +
          "<th style='text-align:right'>Hours</th></tr></thead><tbody>";
  data.entries.slice(0, 25).forEach(function (e) {
    html += "<tr><td>" + esc(e.userName) + "</td><td>" + esc(e.clientName || "Internal") +
            "</td><td>" + esc(e.date) + "</td><td class='num'>" + esc(h(e.hours)) + "</td></tr>";
  });
  html += "</tbody></table>";
  if (data.entries.length > 25) {
    html += "<div class='note'>Showing 25 of " + esc(data.entries.length) + ".</div>";
  }
  root.innerHTML = html;
`;

/**
 * Hours per person for a period, as a chart and the table behind it.
 *
 * A stacked bar rather than two: billable and non-billable are parts of one
 * measure, and what the reader wants is the share, which a split bar shows and
 * two separate bars make them compute. One hue, two steps, for the same
 * reason - a second colour would imply a second subject.
 *
 * The table is not a fallback. Every value in the chart is in it, so the
 * figures stay reachable without hovering and the view carries its own
 * accessible twin.
 */
export const TEAM_VIEW = `
  var people = (data.people || []).slice().sort(function (a, b) { return b.totalHours - a.totalHours; });
  var html = "<h1>" + esc(data.label || "Team report") + "</h1>";

  if (!people.length) {
    root.innerHTML = html + "<div class='empty'>No time recorded in this period</div>";
    return;
  }

  var totals = people.reduce(function (acc, p) {
    acc.hours += Number(p.totalHours || 0);
    acc.billable += Number(p.billableHours || 0);
    return acc;
  }, { hours: 0, billable: 0 });
  var share = totals.hours > 0 ? (100 * totals.billable / totals.hours) : 0;

  html += "<div class='grid'>" +
          "<div class='tile'><div class='k'>People</div><div class='v'>" + esc(people.length) + "</div></div>" +
          "<div class='tile'><div class='k'>Logged</div><div class='v'>" + esc(h(totals.hours)) + "</div></div>" +
          "<div class='tile'><div class='k'>Billable</div><div class='v'>" + esc(h(totals.billable)) + "</div></div>" +
          "<div class='tile'><div class='k'>Billable share</div><div class='v " +
          (share >= 85 ? "ok" : share >= 60 ? "" : "warn") + "'>" +
          esc(Math.round(share) + "%") + "</div></div></div>";

  html += "<div class='legend'><span><i class='billable'></i>Billable</span>" +
          "<span><i class='nonbill'></i>Non-billable</span></div>";

  // Every bar is drawn against the busiest person, so the lengths compare.
  var max = people[0].totalHours || 1;
  html += "<div class='chart'>";
  people.forEach(function (p) {
    var total = Number(p.totalHours || 0);
    var billable = Number(p.billableHours || 0);
    var nonBill = Math.max(0, total - billable);
    var width = Math.max(1, (total / max) * 100);
    var billShare = total > 0 ? (billable / total) * 100 : 0;
    html += "<div class='bar-row'>" +
            "<div class='bar-name' title='" + esc(p.userName) + "'>" + esc(p.userName) + "</div>" +
            "<div class='bar-track'><div class='bar' style='width:" + width + "%'>" +
            "<div class='seg billable" + (nonBill > 0 ? "" : " capped") + "' style='width:" + billShare + "%'></div>" +
            (nonBill > 0 ? "<div class='seg nonbill' style='flex:1'></div>" : "") +
            "</div></div>" +
            // Labelled at the tip only: a number on every segment is chaos.
            "<div class='bar-value'>" + esc(h(total)) + "</div></div>";
  });
  html += "</div>";

  html += "<table><thead><tr><th>Person</th>" +
          "<th style='text-align:right'>Total</th>" +
          "<th style='text-align:right'>Billable</th>" +
          "<th style='text-align:right'>Non-billable</th>" +
          "<th style='text-align:right'>Billable %</th></tr></thead><tbody>";
  people.forEach(function (p) {
    var total = Number(p.totalHours || 0);
    var billable = Number(p.billableHours || 0);
    var pct = total > 0 ? Math.round(100 * billable / total) : 0;
    html += "<tr><td>" + esc(p.userName) + "</td>" +
            "<td class='num'>" + esc(h(total)) + "</td>" +
            "<td class='num'>" + esc(h(billable)) + "</td>" +
            "<td class='num'>" + esc(h(Math.max(0, total - billable))) + "</td>" +
            "<td class='num'>" + esc(pct + "%") + "</td></tr>";
  });
  html += "</tbody></table>";

  if (data.clientCount) {
    html += "<div class='note'>Across " + esc(data.clientCount) +
            (data.clientCount === 1 ? " client" : " clients") + ".</div>";
  }

  root.innerHTML = html;
`;
