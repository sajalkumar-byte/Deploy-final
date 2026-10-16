'use strict';
/* routes/auth.js – signing in and out, who am I, and changing your own password. */

const config = require('../../config');
const users = require('../../model/users');
const sessions = require('../../model/sessions');
const audit = require('../../model/audit');
const permissions = require('../../model/permissions');
const resets = require('../../model/resets');
const mailer = require('../../view/mailer');
const { createLimiter } = require('../middleware');
const { verifyPassword } = require('../../model/crypto');
const { readJson, sendJson, setCookie, clearCookie, clientIp, badRequest, unauthorized, tooMany } = require('../../view/http');
const { loginLimiter, requireUser } = require('../middleware');

/** The payload the browser receives about the signed-in person. */
function sessionPayload(user, csrf, expiresAt, token) {
  return {
    user: { email: user.email, name: user.name, role: user.role, id: user.id },
    permissions: permissions.describe(user.role),
    csrf,
    expiresAt,
    token,            // for API clients that cannot use cookies
  };
}

/* One address may only ask for a handful of codes per hour, so nobody can be mail-bombed. */
const resetLimiter = createLimiter(config.resetMaxRequests, config.resetRequestWindowMs);

function register(router) {

  /* ---- POST /api/auth/forgot – email a six-digit code ---- */
  router.post('/api/auth/forgot', async (req, res, ctx) => {
    /* Refused before anything else when email is off, so no code is written to the database
       for a message that will never be sent. */
    if (!config.mail.enabled) {
      throw badRequest('Password reset by email is switched off here. Ask the super admin to set a new password for you.', 'mail_off');
    }
    const body = await readJson(req);
    const email = users.normalizeEmail(body.email);
    const ip = clientIp(req);
    if (!users.EMAIL_RE.test(email)) throw badRequest('Enter a valid email address', 'bad_email');

    const gate = resetLimiter.hit(email);
    if (!gate.ok) {
      const err = tooMany(`Too many codes requested for that address. Try again in ${Math.ceil(gate.retryAfter / 60)} minute(s).`);
      err.retryAfter = gate.retryAfter;
      throw err;
    }

    const user = await users.byEmail(email);
    if (user) {
      const code = resets.newCode();
      await resets.create(email, code);
      const message = mailer.resetEmail(user.name, code, config.resetCodeMinutes);
      try {
        await mailer.send({ to: user.email, ...message });
        await audit.log({ actor: email, role: user.role, action: 'password.forgot', target: email, detail: 'code sent', ip });
      } catch (e) {
        await resets.remove(email);
        await audit.log({ actor: email, action: 'password.forgot.failed', target: email, detail: String(e.message), ip });
        throw new (require('../../view/http').HttpError)(500, 'mail_failed',
          'The code could not be emailed. Ask the super admin to reset your password instead.');
      }
    } else {
      await audit.log({ actor: email, action: 'password.forgot', target: email, detail: 'no such account', ip });
    }

    /* Deliberately the same answer either way, so this cannot be used to discover who has an account. */
    sendJson(res, 200, {
      ok: true,
      message: `If that address has an account, a six-digit code is on its way. It expires in ${config.resetCodeMinutes} minutes.`,
    });
  });

  /* ---- POST /api/auth/reset – the code plus a new password ---- */
  router.post('/api/auth/reset', async (req, res, ctx) => {
    const body = await readJson(req);
    const email = users.normalizeEmail(body.email);
    const code = String(body.code || '').replace(/\s+/g, '');
    const next = String(body.newPassword || '');
    const ip = clientIp(req);

    if (next.length < 4) throw badRequest('The new password must be at least 4 characters', 'bad_password');
    if (!code) throw badRequest('Enter the code from the email', 'bad_code');

    const check = await resets.verify(email, code);
    if (!check.ok) {
      await audit.log({ actor: email, action: 'password.reset.failed', target: email, detail: check.code, ip });
      throw new (require('../../view/http').HttpError)(check.code === 'too_many_tries' ? 429 : 400, check.message, check.code);
    }

    const user = await users.byEmail(email);
    if (!user) { await resets.remove(email); throw badRequest('No account with that email', 'not_found'); }

    await users.update(email, { password: next });
    await resets.remove(email);
    await sessions.destroyForEmail(email);          // every old sign-in of this account stops working
    resetLimiter.reset(email);
    await audit.log({ actor: email, role: user.role, action: 'password.reset', target: email, detail: 'by emailed code', ip });
    sendJson(res, 200, { ok: true, message: 'Your password has been changed. Please sign in.' });
  });

  /* ---- POST /api/auth/login ---- */
  router.post('/api/auth/login', async (req, res, ctx) => {
    const body = await readJson(req);
    const email = users.normalizeEmail(body.email);
    const password = String(body.password || '');
    const ip = clientIp(req);

    if (!email || !password) throw badRequest('Enter your email and password', 'missing_credentials');

    const key = `${email}|${ip}`;
    const gate = loginLimiter.hit(key);
    if (!gate.ok) {
      await audit.log({ actor: email, action: 'login.blocked', detail: 'rate limited', ip });
      const err = tooMany(`Too many sign-in attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minute(s).`);
      err.retryAfter = gate.retryAfter;
      throw err;
    }

    const row = await users.rawByEmail(email);
    /* Always run a hash comparison so a missing account and a wrong password take the same time. */
    const ok = row ? verifyPassword(password, row.password) : verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    if (!row || !ok) {
      await audit.log({ actor: email, action: 'login.failed', ip });
      throw unauthorized('Email or password is not correct');
    }

    loginLimiter.reset(key);
    const { token, csrf, expiresAt } = await sessions.create(row.email, { userAgent: req.headers['user-agent'] || '', ip });
    await users.touchLogin(row.email);
    await audit.log({ actor: row.email, role: row.role, action: 'login', ip });

    const maxAge = config.sessionTtlHours * 3600;
    setCookie(res, config.sessionCookie, token, { maxAge, httpOnly: true });
    setCookie(res, config.csrfCookie, csrf, { maxAge, httpOnly: false });

    sendJson(res, 200, sessionPayload(users.publicUser(row), csrf, expiresAt, token));
  });

  /* ---- POST /api/auth/logout ---- */
  router.post('/api/auth/logout', async (req, res, ctx) => {
    if (ctx.token) await sessions.destroy(ctx.token);
    if (ctx.user) await audit.log({ actor: ctx.user.email, role: ctx.user.role, action: 'logout', ip: clientIp(req) });
    clearCookie(res, config.sessionCookie);
    clearCookie(res, config.csrfCookie, { httpOnly: false });
    sendJson(res, 200, { ok: true });
  });

  /* ---- GET /api/auth/me – also tells a signed-out browser whether any account exists yet ---- */
  router.get('/api/auth/me', async (req, res, ctx) => {
    if (!ctx.user) {
      return sendJson(res, 200, {
        user: null,
        permissions: null,
        setupRequired: await users.count() === 0,
        roles: permissions.ROLES.map(r => permissions.describe(r)),
      });
    }
    const expiresAt = await sessions.touch(ctx.token);
    sendJson(res, 200, {
      ...sessionPayload(ctx.user, ctx.session.csrf, expiresAt),
      setupRequired: false,
      roles: permissions.ROLES.map(r => permissions.describe(r)),
    });
  });

  /* ---- POST /api/auth/password – change your own password ---- */
  router.post('/api/auth/password', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const body = await readJson(req);
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');
    if (next.length < 4) throw badRequest('The new password must be at least 4 characters', 'bad_password');

    const row = await users.rawByEmail(me.email);
    /* 400, not 401: the person IS signed in, they just mistyped. A 401 here would make the
       page think the session had expired and sign them out. */
    if (!row || !verifyPassword(current, row.password)) {
      throw badRequest('Your current password is not correct', 'bad_current');
    }
    await users.update(me.email, { password: next });
    /* Your other devices are signed out, but the one you are using stays signed in. */
    const others = ctx.token
      ? await sessions.destroyOthers(me.email, ctx.token)
      : await sessions.destroyForEmail(me.email);
    await audit.log({ actor: me.email, role: me.role, action: 'password.change', ip: clientIp(req) });
    sendJson(res, 200, { ok: true, message: 'Your password has been changed.', otherSessionsEnded: others });
  });

  /* ---- POST /api/auth/profile – change your own display name ---- */
  router.post('/api/auth/profile', async (req, res, ctx) => {
    const me = requireUser(ctx);
    const body = await readJson(req);
    const name = String(body.name || '').trim();
    if (!name) throw badRequest('Enter a name', 'bad_name');
    if (name.length > 120) throw badRequest('That name is too long', 'bad_name');
    const updated = await users.update(me.email, { name });
    await audit.log({ actor: me.email, role: me.role, action: 'profile.update', target: me.email,
                detail: 'name', ip: clientIp(req) });
    sendJson(res, 200, updated);
  });

  /* ---- POST /api/auth/setup – create the first super admin, only while no account exists ---- */
  router.post('/api/auth/setup', async (req, res, ctx) => {
    if (await users.count() > 0) throw badRequest('Setup has already been completed – please sign in', 'already_setup');
    const body = await readJson(req);
    const created = await users.create({
      email: body.email, name: body.name, role: 'superadmin',
      password: body.password, createdBy: 'setup',
    });
    const ip = clientIp(req);
    const { token, csrf, expiresAt } = await sessions.create(created.email, { userAgent: req.headers['user-agent'] || '', ip });
    const maxAge = config.sessionTtlHours * 3600;
    setCookie(res, config.sessionCookie, token, { maxAge, httpOnly: true });
    setCookie(res, config.csrfCookie, csrf, { maxAge, httpOnly: false });
    await audit.log({ actor: created.email, role: 'superadmin', action: 'setup', ip });
    sendJson(res, 201, sessionPayload(created, csrf, expiresAt, token));
  });
}

module.exports = { register, sessionPayload };
