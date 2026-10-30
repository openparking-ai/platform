/**
 * What the emails say (0032), in English and Spanish, in plain words. Each
 * returns `{ subject, text }`; there is no HTML.
 *
 * The invite and the reset go to the person, in their language: the invite's
 * (`invite-admin --language`), the admin's own for a reset. The notice goes to
 * the deployment's EMAIL_NOTICE_TO and is in English. A link is written here
 * and nowhere else: never in a log, never in an error.
 */

const LOCALES = Object.freeze({ en: 'en-GB', es: 'es-ES' });

/** "17 October 2026, 18:01 UTC" / "17 de octubre de 2026, 18:01 UTC". */
export function whenUtc(at, language = 'en') {
  const day = new Intl.DateTimeFormat(LOCALES[language] ?? LOCALES.en, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(at);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(at);
  return `${day}, ${time} UTC`;
}

const INVITE = {
  en: ({ company, link, ends }) => ({
    subject: 'Your Open Parking account',
    text: [
      `You are invited to set up the Open Parking account for ${company}.`,
      '',
      'Choose your password here:',
      link,
      '',
      `The link works once, and it ends on ${ends}. If it has ended, ask for a new invite.`,
      '',
      'If you did not expect this email, you can ignore it. No account is made until the link is used.',
    ].join('\n'),
  }),
  es: ({ company, link, ends }) => ({
    subject: 'Su cuenta de Open Parking',
    text: [
      `Le invitamos a configurar la cuenta de Open Parking de ${company}.`,
      '',
      'Elija su contraseña aquí:',
      link,
      '',
      `El enlace funciona una sola vez y vence el ${ends}. Si ya venció, pida una nueva invitación.`,
      '',
      'Si no esperaba este correo, puede ignorarlo. No se crea ninguna cuenta hasta que se use el enlace.',
    ].join('\n'),
  }),
};

const RESET = {
  en: ({ link }) => ({
    subject: 'Reset your Open Parking password',
    text: [
      'Someone asked to reset the password of the Open Parking account for this email address.',
      '',
      'Choose a new password here:',
      link,
      '',
      'The link works once, and it ends in one hour. Using it signs out every session of the account and removes its passkeys.',
      '',
      'If you did not ask for this, you can ignore this email. Your password stays as it is.',
    ].join('\n'),
  }),
  es: ({ link }) => ({
    subject: 'Restablezca su contraseña de Open Parking',
    text: [
      'Alguien pidió restablecer la contraseña de la cuenta de Open Parking de esta dirección de correo.',
      '',
      'Elija una nueva contraseña aquí:',
      link,
      '',
      'El enlace funciona una sola vez y vence en una hora. Al usarlo se cierran todas las sesiones de la cuenta y se quitan sus llaves de acceso.',
      '',
      'Si no lo pidió, puede ignorar este correo. Su contraseña no cambia.',
    ].join('\n'),
  }),
};

/** The invite: whose account, the link, and when it ends. */
export function inviteEmail(language, { company, link, expiresAt }) {
  const say = INVITE[language] ?? INVITE.en;
  return say({ company, link, ends: whenUtc(expiresAt, language) });
}

/** The reset link, in the admin's language. */
export function resetEmail(language, { link }) {
  return (RESET[language] ?? RESET.en)({ link });
}

const PASSKEY_ADDED = {
  en: ({ name, when }) => ({
    subject: 'A passkey was added to your Open Parking account',
    text: [
      `A passkey named "${name}" was added to the Open Parking account for this email address on ${when}.`,
      '',
      'It signs in to the account as your password does.',
      '',
      'If you did not add it, reset your password now: that signs out every session and removes every passkey.',
    ].join('\n'),
  }),
  es: ({ name, when }) => ({
    subject: 'Se agregó una llave de acceso a su cuenta de Open Parking',
    text: [
      `Se agregó una llave de acceso llamada "${name}" a la cuenta de Open Parking de esta dirección de correo el ${when}.`,
      '',
      'Con ella se entra a la cuenta como con su contraseña.',
      '',
      'Si no la agregó usted, restablezca su contraseña ahora: así se cierran todas las sesiones y se quitan todas las llaves de acceso.',
    ].join('\n'),
  }),
};

const PASSKEYS_REMOVED = {
  en: ({ count, when }) => ({
    subject: 'Your Open Parking passkeys were removed',
    text: [
      `The password of the Open Parking account for this email address was changed on ${when}.`,
      '',
      `${count === 1 ? 'Its passkey was' : `Its ${count} passkeys were`} removed with it, and every session was signed out. Sign in with the new password, then add a passkey again if you want one.`,
      '',
      'If you did not change the password, reset it again now.',
    ].join('\n'),
  }),
  es: ({ count, when }) => ({
    subject: 'Se quitaron sus llaves de acceso de Open Parking',
    text: [
      `La contraseña de la cuenta de Open Parking de esta dirección de correo se cambió el ${when}.`,
      '',
      `${count === 1 ? 'Se quitó su llave de acceso' : `Se quitaron sus ${count} llaves de acceso`} y se cerraron todas las sesiones. Entre con la nueva contraseña y, si quiere, agregue de nuevo una llave de acceso.`,
      '',
      'Si no cambió la contraseña, restablézcala de nuevo ahora.',
    ].join('\n'),
  }),
};

/** To the account holder: a passkey was added, its name and when. Holds no key and no link. */
export function passkeyAddedEmail(language, { name, at }) {
  return (PASSKEY_ADDED[language] ?? PASSKEY_ADDED.en)({ name, when: whenUtc(at, language) });
}

/** To the account holder: a password change removed their passkeys, how many and when. */
export function passkeysRemovedEmail(language, { count, at }) {
  return (PASSKEYS_REMOVED[language] ?? PASSKEYS_REMOVED.en)({ count, when: whenUtc(at, language) });
}

/** To the deployment's EMAIL_NOTICE_TO: an invite was accepted. Holds no link. */
export function acceptedNotice({ email, company, tenantId, at }) {
  return {
    subject: `Invite accepted: ${company}`,
    text: [
      `${email} accepted the invite and is now the admin of ${company} (tenant ${tenantId}).`,
      '',
      `Accepted ${whenUtc(at)}.`,
    ].join('\n'),
  };
}
