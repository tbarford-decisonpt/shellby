// Snags and crash reports. Keeping him alive through a stray throw is the right
// trade for a desk pet: vanishing mid-task tells the user nothing and loses the
// conversation. It is written down, and he says so once, rather than being
// swallowed. Sentry is held back by the user's answer (crash-report.js).
// Kept out of main.js, which only wires it up (and hangs snag() on the
// process's own error events there, before anything else can throw).
const os = require('os');
const { app } = require('electron');
const crashReport = require('../crash-report');

const SNAGS_TOLD = 3; // a loop must not become a storm of toasts, or of reports

/** d: what main shares (main.js `shared`). */
function wireCrash(d) {
  // ---- snags

  let snags = 0;
  function snag(what, detail) {
    d.log.error(what, detail);
    if (++snags > SNAGS_TOLD) return;
    const { sentry } = d;
    // A dead window's native crash reaches Sentry as a dump of its own; these don't.
    if (sentry && detail instanceof Error) sentry.captureException(detail, { tags: { snag: what } });
    else if (sentry && what === 'unhandled rejection') sentry.captureMessage(`${what}: ${detail}`, 'error');
    // No config yet means this is a crash during startup, before there's anywhere
    // to show it (and notify() would throw from inside the handler).
    if (!d.config) return;
    const ask = sentry && crashConsent() === 'ask';
    d.notify('Shellby hit a snag', ask ? 'He carried on, but something went wrong. Send a report so it gets fixed?' : 'He carried on, but something went wrong. Right-click him → Report a problem.',
      ask ? () => d.askToSend('snag') : d.reportProblem, { tone: 'problem', action: ask ? 'Send report' : 'Report it' });
  }

  const crashConsent = () => crashReport.normalizeConsent(d.config?.get('crashReports'));

  // ---- crash reports

  // Started before the app is ready so a native crash is caught from the first
  // moment. Only by the Shellby holding the lock: a second launch bowing out
  // isn't a crash. -> { lastRun, sentry }
  function startCrashReports(primary) {
    const bootedAt = Date.now() - os.uptime() * 1000;
    const lastRun = primary && !d.CAPTURE ? crashReport.startRun(d.LOG_DIR, { version: app.getVersion(), bootedAt }) : { unclean: false };
    return { lastRun, sentry: primary ? startSentry() : null };
  }

  function startSentry() {
    const dsn = crashReport.dsnFor({ env: process.env, isPackaged: app.isPackaged, capture: d.CAPTURE });
    if (!dsn) return null;
    // Before settings load (or if reading them throws) the gate holds everything.
    const crashGate = crashReport.makeGate(() => d.config && { consent: d.config.get('crashReports'), decisions: d.config.get('crashReportDecisions') });
    try {
      const S = require('@sentry/electron/main');
      const scrub = s => d.log.scrub(s);
      S.init({
        dsn,
        release: `shellby@${app.getVersion()}`,
        environment: app.isPackaged ? 'production' : 'development',
        sendDefaultPii: false,
        integrations: crashReport.keepIntegrations,
        transportOptions: { shouldSend: crashGate.shouldSend, shouldStore: crashGate.shouldStore },
        beforeSend: event => crashReport.scrubEvent(event, scrub),
        beforeBreadcrumb: crumb => crashReport.scrubEvent(crumb, scrub),
      });
      return S;
    } catch (e) {
      d.log.warn('crash reports unavailable', e);
      return null;
    }
  }

  return { crashConsent, snag, startCrashReports };
}

module.exports = { wireCrash };
