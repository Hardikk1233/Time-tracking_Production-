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
    --amber: #a16207; --crimson: #a4232c; --green: #1f6b4a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #0e1218; --surface: #161b23; --surface-2: #1c222b;
      --ink: #e7e8e4; --ink-2: #a4abb8; --ink-3: #737b88;
      --navy: #8fb0dd; --rule: #2a313c; --rule-soft: #222932;
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
