/**
 * The currencies a garage can keep its money in: the currencies in use today
 * (ISO 4217, list one, as of 2026), less funds, precious metals, drawing
 * rights and the testing and no-currency codes -- money no driver pays a
 * garage in. The admin screen offers exactly this list (its src/garages.js),
 * so the platform takes what the screen offers and nothing else.
 *
 * Written down here, not asked of the runtime: what Node's own list holds
 * depends on the ICU it was built with, and has codes withdrawn years ago.
 */
export const CURRENCY_CODES = Object.freeze((
  'AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP ' +
  'CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG ' +
  'HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL ' +
  'MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR ' +
  'RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD ' +
  'TZS UAH UGX USD UYU UZS VED VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG'
).split(' '));

const KNOWN = new Set(CURRENCY_CODES);

/** Whether `code` is one of them, exactly as written: "usd" is not. */
export const isCurrency = (code) => typeof code === 'string' && KNOWN.has(code);
