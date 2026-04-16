/* === CONFIG === */
const ADMIN_EMAIL = 'carnirawfeed@gmail.com';
const CALENDAR_NAME = 'carniraw feed';
const SHEET_NAME = 'Birthday Signups';
const TZ = 'Africa/Johannesburg';
const LOG_SPREADSHEET_ID = ''; // optional
/* === END CONFIG === */


/* Helper: safe calendar */
function getOrCreateCalendarByName(name) {
  let safeName = (typeof name === 'string') ? name.trim() : '';
  if (!safeName) safeName = 'Pet Birthdays';
  const cals = CalendarApp.getCalendarsByName(safeName);
  if (cals && cals.length > 0) return cals[0];
  return CalendarApp.createCalendar(safeName);
}


/* Helper: logging sheet */
function getOrCreateLogSheet() {
  if (LOG_SPREADSHEET_ID && LOG_SPREADSHEET_ID.trim()) {
    return SpreadsheetApp.openById(LOG_SPREADSHEET_ID);
  }
  const files = DriveApp.getFilesByName(SHEET_NAME);
  if (files.hasNext()) return SpreadsheetApp.open(files.next());
  const ss = SpreadsheetApp.create(SHEET_NAME);
  ss.getActiveSheet().appendRow([
    'Timestamp','OwnerName','OwnerEmail','DogName','DOB',
    'ReminderDays','Source','CalendarEventId'
  ]);
  return ss;
}


/* compute next occurrence */
function nextOccurrenceISO(dobString) {
  const parts = (dobString||'').split('-');
  if (parts.length < 3) throw new Error('Invalid dob format. Use YYYY-MM-DD');

  const month = parseInt(parts[1],10);
  const day = parseInt(parts[2],10);

  if (isNaN(month) || isNaN(day)) throw new Error('Invalid month/day in DOB');

  const now = new Date();
  let year = now.getFullYear();

  const candidate = new Date(year, month-1, day, 9, 0, 0);
  if (candidate.getTime() < now.getTime()) year++;

  const start = new Date(year, month-1, day, 9, 0, 0);
  const end = new Date(year, month-1, day, 9, 30, 0);

  return {
    startISO: Utilities.formatDate(start, TZ, "yyyy-MM-dd'T'HH:mm:ss"),
    endISO: Utilities.formatDate(end, TZ, "yyyy-MM-dd'T'HH:mm:ss"),
    year, month, day
  };
}


/* HTML response back to iframe */
function htmlPostMessage(obj) {
  const payload = JSON.stringify(obj).replace(/</g, '\\u003c');

  const html = "<!doctype html><html><head><meta charset='utf-8'></head><body>"
    + "<script>"
    + "try{window.parent.postMessage(" + payload + ", '*');}catch(e){}"
    + "document.write('<div style=\"font-family:Arial,sans-serif;padding:20px;font-size:15px;\">Thanks — you may close this window.</div>');"
    + "</script></body></html>";

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/* MAIN HANDLER */
function doPost(e) {
  try {

    let payload = {};

    if (e.postData && e.postData.type && e.postData.type.indexOf('application/json') !== -1) {
      payload = JSON.parse(e.postData.contents);
    } else {
      payload = e.parameter || {};
    }

    // Honeypot spam check
    if (payload.hp && String(payload.hp).trim() !== '') {
      return htmlPostMessage({ok:false, err:'spam detected'});
    }

    const ownerName = (payload.ownerName || payload.owner || '').trim();
    const ownerEmail = (payload.ownerEmail || payload.email || '').trim();
    const dogName = (payload.dogName || payload.petName || '').trim();
    const dob = (payload.dob || '').trim();
    const reminderDays = Number(payload.reminderDays || 0);
    const source = payload.source || 'webform';

    if (!ownerEmail || !dogName || !dob) {
      return htmlPostMessage({ok:false, err:'missing required fields (ownerEmail, dogName, dob)'});
    }

    const cal = getOrCreateCalendarByName(CALENDAR_NAME);
    const calId = cal.getId();

    const {startISO, endISO, year, month, day} = nextOccurrenceISO(dob);

    const rrule = `RRULE:FREQ=YEARLY;BYMONTH=${month};BYMONTHDAY=${day}`;

    /* ✅ UPDATED EVENT STRUCTURE */
    const eventResource = {
      summary: `${dogName} (Owner: ${ownerName}) — Birthday`,
      description:
`🐶 Dog: ${dogName}
👤 Owner: ${ownerName}
📧 Email: ${ownerEmail}

🎁 Action: Send birthday reward

Added via: ${source}`,
      start: { dateTime: startISO, timeZone: TZ },
      end: { dateTime: endISO, timeZone: TZ },
      recurrence: [ rrule ],
      attendees: [
        { email: "deli@carniraw.co.za" },
        ...(ownerEmail ? [{ email: ownerEmail }] : [])
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: Math.max(1,reminderDays) * 24 * 60 },
          { method: 'email', minutes: Math.max(1,reminderDays) * 24 * 60 }
        ]
      }
    };

    const inserted = Calendar.Events.insert(eventResource, calId);

    /* LOG */
    const ss = getOrCreateLogSheet();
    ss.getActiveSheet().appendRow([
      new Date().toISOString(),
      ownerName,
      ownerEmail,
      dogName,
      dob,
      reminderDays,
      source,
      inserted.id || ''
    ]);

    /* EMAILS */

    // Customer
    MailApp.sendEmail({
      to: ownerEmail,
      subject: `Birthday added for ${dogName}`,
      body:
`Hi ${ownerName || 'there'},

We've added ${dogName}'s birthday to the Carniraw calendar.

Date: ${dob}
Next occurrence: ${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}
Reminder: ${reminderDays} day(s) before.

— Carniraw`
    });

    // Deli team
    MailApp.sendEmail({
      to: "deli@carniraw.co.za",
      subject: `New Birthday Added: ${dogName}`,
      body:
`New birthday entry submitted:

Owner: ${ownerName} <${ownerEmail}>
Dog: ${dogName}
DOB: ${dob}

Event ID: ${inserted.id}`
    });

    // Admin
    MailApp.sendEmail({
      to: ADMIN_EMAIL,
      subject: `New birthday added: ${dogName}`,
      body:
`Owner: ${ownerName} <${ownerEmail}>
Dog: ${dogName}
DOB: ${dob}
Event ID: ${inserted.id}`
    });

    return htmlPostMessage({
      ok:true,
      eventId: inserted.id || '',
      calendarId: calId
    });

  } catch (err) {
    console.error(err);
    return htmlPostMessage({ok:false, err: String(err)});
  }
}
