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
      'The link works once, and it ends in one hour. Using it signs out every session of the account.',
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
      'El enlace funciona una sola vez y vence en una hora. Al usarlo se cierran todas las sesiones de la cuenta.',
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
