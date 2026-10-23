/**
 * Vercel-Funktion für das Kontaktformular „L!GA ONE kennenlernen“ (POST /api/kontakt).
 *
 * Prüft alle Angaben serverseitig, filtert Spam und verschickt die Anfrage per SMTP
 * an LIGA ONE. Zugangsdaten kommen ausschliesslich aus den Environment Variables
 * in Vercel (siehe .env.example) und gelangen nie ins Frontend.
 *
 * Antwort (JSON): { ok: true }  oder  { ok: false, error: "…" }
 */

const nodemailer = require('nodemailer');

const MIN_MS = 3000;          // schneller ausgefüllt = Bot
const MAX_PRO_STUNDE = 5;     // Anfragen pro IP-Adresse und Stunde (je Server-Instanz)
const ARTEN = {
  workshop: 'Kostenlosen LIVE-Workshop anfragen',
  allgemein: 'Allgemeine Anfrage / Erstgespräch',
};
const FEHLER_VERSAND = 'Ihre Anfrage konnte leider nicht gesendet werden. Bitte versuchen Sie es in einem Moment erneut oder schreiben Sie uns an info@liga-one-gmbh.ch. Ihre Eingaben bleiben erhalten.';

const anfragenProIp = new Map();

function antwort(res, code, daten) {
  res.status(code).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(daten));
}

function text(wert, max) {
  return String(wert ?? '').replace(/\0/g, '').trim().slice(0, max);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return antwort(res, 405, { ok: false, error: 'Ungültige Anfrage.' });
  }

  // Nur Anfragen von der eigenen Website annehmen
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return antwort(res, 403, { ok: false, error: 'Ungültige Anfrage.' });
      }
    } catch {
      return antwort(res, 403, { ok: false, error: 'Ungültige Anfrage.' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // ---------- Spam-Schutz ----------
  // 1) Honeypot: unsichtbares Feld muss leer sein. Bots erhalten scheinbar Erfolg.
  if (text(body.website, 200) !== '') return antwort(res, 200, { ok: true });

  // 2) Mindestzeit zwischen Laden und Absenden
  const ts = Number(body.ts) || 0;
  if (ts <= 0 || Date.now() - ts < MIN_MS) {
    return antwort(res, 400, { ok: false, error: 'Bitte prüfen Sie Ihre Eingaben und senden Sie das Formular erneut.' });
  }

  // 3) Begrenzung pro IP-Adresse
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unbekannt';
  const jetzt = Date.now();
  const liste = (anfragenProIp.get(ip) || []).filter(t => t > jetzt - 3600 * 1000);
  if (liste.length >= MAX_PRO_STUNDE) {
    return antwort(res, 429, { ok: false, error: 'Es wurden bereits mehrere Anfragen gesendet. Bitte versuchen Sie es später erneut oder schreiben Sie uns an info@liga-one-gmbh.ch.' });
  }

  // ---------- Serverseitige Prüfung ----------
  const art = text(body.anfrageart, 20);
  const unternehmen = text(body.unternehmen, 200);
  const kontaktperson = text(body.kontaktperson, 200);
  const email = text(body.email, 254);
  const anliegen = text(body.anliegen, 5000);
  const datenschutz = body.datenschutz === true || body.datenschutz === '1';

  const fehler = [];
  if (!ARTEN[art]) fehler.push('Anliegen');
  if (!unternehmen) fehler.push('Unternehmen');
  if (!kontaktperson) fehler.push('Kontaktperson');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fehler.push('Geschäftliche E-Mail');
  if (!anliegen) fehler.push('Ihr Anliegen / Ihre Fokusthemen');
  if (!datenschutz) fehler.push('Datenschutzhinweise');
  if (fehler.length) {
    return antwort(res, 422, { ok: false, error: 'Bitte prüfen Sie folgende Angaben: ' + fehler.join(', ') + '.' });
  }
  if ([unternehmen, kontaktperson, email].some(w => /[\r\n]/.test(w))) {
    return antwort(res, 400, { ok: false, error: 'Bitte prüfen Sie Ihre Eingaben.' });
  }

  // ---------- E-Mail an LIGA ONE ----------
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_TO } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.error('Kontaktformular: SMTP-Einstellungen fehlen in den Environment Variables.');
    return antwort(res, 500, { ok: false, error: FEHLER_VERSAND });
  }

  const port = Number(SMTP_PORT) || 465;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const datum = new Date().toLocaleString('de-CH', { timeZone: 'Europe/Zurich' });
  const betreff = (art === 'workshop' ? 'LIVE-Workshop-Anfrage' : 'Allgemeine Anfrage') + ' – ' + unternehmen;
  const inhalt = [
    'Neue Anfrage über die Website (Kontaktformular „L!GA ONE kennenlernen“)',
    '',
    'Anliegen:        ' + ARTEN[art],
    'Unternehmen:     ' + unternehmen,
    'Kontaktperson:   ' + kontaktperson,
    'E-Mail:          ' + email,
    '',
    'Ihr Anliegen / Ihre Fokusthemen:',
    anliegen,
    '',
    '—',
    'Datenschutzhinweise bestätigt: ja',
    'Gesendet am: ' + datum,
  ].join('\n');

  try {
    await transporter.sendMail({
      from: { name: 'LIGA ONE Website', address: MAIL_FROM || SMTP_USER },
      to: MAIL_TO || 'info@liga-one-gmbh.ch',
      replyTo: { name: kontaktperson, address: email },
      subject: betreff,
      text: inhalt,
    });
  } catch (err) {
    console.error('Kontaktformular: Versand fehlgeschlagen –', err && err.message);
    return antwort(res, 502, { ok: false, error: FEHLER_VERSAND });
  }

  liste.push(jetzt);
  anfragenProIp.set(ip, liste);
  return antwort(res, 200, { ok: true });
};
