/**
 * Task and Project Tracker – LOADER
 * =================================
 * Paste THIS SHORT FILE into Apps Script, not the big one.
 *
 * It downloads the real code from the repository and runs it, which means two things:
 *   · there is almost nothing to paste, so the wrong file cannot end up here by mistake;
 *   · improvements arrive on their own. When the code in the repository changes, this picks it
 *     up within an hour, or straight away if you run refreshTrackerCode.
 *
 * Setup, once:
 *   1. Extensions → Apps Script, select everything in Code.gs, paste this over it, save.
 *   2. Run  setupTracker  and allow the permissions it asks for.
 *   3. Run  addSampleData  if you would like some example rows.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *      (If you already have a deployment: Deploy → Manage deployments → ✏ → New version.)
 */

var TRACKER_SOURCE = 'https://raw.githubusercontent.com/sajalkumar-byte/Infrastructure-and-Support-Technology-Task-Tracker/main/google-apps-script/Code.gs';
var TRACKER_CACHE_MINUTES = 60;

var _tracker = null;

/** Fetch the tracker code (cached), run it, and hand back the functions it exposes. */
function tracker_() {
  if (_tracker) return _tracker;

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  var source = cache ? cache.get('tracker_src') : null;
  if (!source) {
    var res = UrlFetchApp.fetch(TRACKER_SOURCE, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) {
      throw new Error('Could not download the tracker code: HTTP ' + res.getResponseCode());
    }
    source = res.getContentText();
    if (source.indexOf('var SHEETS') === -1) {
      throw new Error('The downloaded file does not look like the tracker code');
    }
    if (cache) { try { cache.put('tracker_src', source, TRACKER_CACHE_MINUTES * 60); } catch (e) {} }
  }

  _tracker = eval('(function(){' + source + '\nreturn {' +
    'doGet: doGet, doPost: doPost, setupTracker: setupTracker, addSampleData: addSampleData,' +
    'addSampleUsers: addSampleUsers, checkDeployment: checkDeployment, cleanUpSessions: cleanUpSessions,' +
    'rebuildViews: rebuildViews' +
    '};})()');
  return _tracker;
}

/**
 * Never called. It exists so that Apps Script asks for the right permissions.
 *
 * Apps Script decides which permissions to request by READING the code in the editor. The real
 * tracker arrives later, through eval, so the scanner cannot see that it will touch the
 * spreadsheet or send mail, and it only asks for permission to fetch a URL. The first call to
 * SpreadsheetApp then fails with "Specified permissions are not sufficient".
 *
 * Mentioning each service here, in code that never runs, is what makes the consent screen ask
 * for all of them. Do not delete this function.
 */
function _permissionsNeeded_() {
  if (new Date().getTime() > 0) return;        // never true at run time
  SpreadsheetApp.getActive().getSheetByName('x');
  SpreadsheetApp.openById('x');
  MailApp.sendEmail({ to: 'x@example.com', subject: 'x', body: 'x' });
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.fetch('https://example.com');
  CacheService.getScriptCache().get('x');
  PropertiesService.getScriptProperties().getProperty('x');
  LockService.getScriptLock().waitLock(1);
  Utilities.getUuid();
  Session.getScriptTimeZone();
  Logger.log('x');
}

/* ---- what the web app and the editor call ---- */
function doGet(e) { return tracker_().doGet(e); }
function doPost(e) { return tracker_().doPost(e); }

function setupTracker() { return tracker_().setupTracker(); }
function addSampleData() { return tracker_().addSampleData(); }
function addSampleUsers() { return tracker_().addSampleUsers(); }
function checkDeployment() { return tracker_().checkDeployment(); }
function cleanUpSessions() { return tracker_().cleanUpSessions(); }
function rebuildViews() { return tracker_().rebuildViews(); }

/** Run this to pick up a code change straight away instead of waiting for the cache to expire. */
function refreshTrackerCode() {
  try { CacheService.getScriptCache().remove('tracker_src'); } catch (e) {}
  _tracker = null;
  var fresh = tracker_();
  Logger.log('Latest tracker code loaded. Health: %s', JSON.stringify(fresh.doGet({ parameter: {} }).getContent()));
  return 'Latest tracker code loaded.';
}
