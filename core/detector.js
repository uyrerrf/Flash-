'use strict';

// ── Financial apps — package → metadata ───────────────────────────────────────
const FINANCIAL_PKGS = {
  // ─── Brazil ────────────────────────────────────────────────────────────────
  'br.com.bradesco':                    { name:'Bradesco',         type:'bank',    country:'BR' },
  'com.bradesco.next':                  { name:'Next (Bradesco)',   type:'neobank', country:'BR' },
  'br.com.itau':                        { name:'Itaú',             type:'bank',    country:'BR' },
  'com.itau.ipad':                      { name:'Itaú iPad',        type:'bank',    country:'BR' },
  'com.itau.empresas':                  { name:'Itaú Empresas',    type:'bank',    country:'BR' },
  'com.nu.production':                  { name:'Nubank',           type:'neobank', country:'BR' },
  'com.santander.app':                  { name:'Santander',        type:'bank',    country:'BR' },
  'br.com.santandertiphone':            { name:'Santander',        type:'bank',    country:'BR' },
  'br.com.bb.android':                  { name:'Banco do Brasil',  type:'bank',    country:'BR' },
  'br.gov.caixa.android':               { name:'Caixa',            type:'bank',    country:'BR' },
  'caixa.mobile.android':               { name:'Caixa Mobile',     type:'bank',    country:'BR' },
  'com.caixa.tem':                      { name:'Caixa Tem',        type:'bank',    country:'BR' },
  'br.com.intermedium':                 { name:'Inter',            type:'neobank', country:'BR' },
  'com.c6bank.app':                     { name:'C6 Bank',          type:'neobank', country:'BR' },
  'com.picpay':                         { name:'PicPay',           type:'payment', country:'BR' },
  'com.mercadopago.wallet':             { name:'Mercado Pago',     type:'payment', country:'BR' },
  'br.com.uol.ps.appparceiro':          { name:'PagSeguro',        type:'payment', country:'BR' },
  'br.com.realwallet':                  { name:'PagSeguro',        type:'payment', country:'BR' },
  'br.com.originalbank':                { name:'Banco Original',   type:'bank',    country:'BR' },
  'br.com.neon.bank.biz':               { name:'Neon',             type:'neobank', country:'BR' },
  'br.com.sicoob.sicoobnet.mobile':     { name:'Sicoob',           type:'bank',    country:'BR' },
  'br.com.banrisul.mobile':             { name:'Banrisul',         type:'bank',    country:'BR' },
  'com.xpinc.mobile':                   { name:'XP Investimentos', type:'broker',  country:'BR' },
  'br.com.modalmais':                   { name:'Modalmais',        type:'broker',  country:'BR' },
  'com.btg.pactual.btgpactualdigital':  { name:'BTG Pactual',      type:'bank',    country:'BR' },
  'br.com.j2.safra':                    { name:'Safra',            type:'bank',    country:'BR' },
  'com.gerencianet.app':                { name:'Gerencianet',      type:'payment', country:'BR' },
  'br.com.agibank.app':                 { name:'Agibank',          type:'bank',    country:'BR' },
  'com.pagseguro.library':              { name:'PagSeguro',        type:'payment', country:'BR' },
  'com.infinitepay.pos':                { name:'InfinitePay',      type:'payment', country:'BR' },
  'br.com.grafeno':                     { name:'Grafeno',          type:'bank',    country:'BR' },
  'br.com.pagbank':                     { name:'PagBank',          type:'bank',    country:'BR' },
  'com.digio':                          { name:'Digio',            type:'neobank', country:'BR' },
  'br.com.zoop.mpos':                   { name:'Zoop',             type:'payment', country:'BR' },

  // ─── USA ──────────────────────────────────────────────────────────────────
  'com.chase.sig.android':              { name:'Chase',            type:'bank',    country:'US' },
  'com.infonow.bofa':                   { name:'Bank of America',  type:'bank',    country:'US' },
  'com.wf.wellsfargomobile':            { name:'Wells Fargo',      type:'bank',    country:'US' },
  'com.citi.citimobile':                { name:'Citi',             type:'bank',    country:'US' },
  'com.usbank.mobilebanking':           { name:'US Bank',          type:'bank',    country:'US' },
  'com.tdbank':                         { name:'TD Bank',          type:'bank',    country:'US' },
  'com.regions.mobile':                 { name:'Regions',          type:'bank',    country:'US' },
  'com.pnc.mobilebanking':              { name:'PNC',              type:'bank',    country:'US' },
  'com.capitalone.mobile':              { name:'Capital One',      type:'bank',    country:'US' },
  'com.paypal.android.p2pmobile':       { name:'PayPal',           type:'payment', country:'US' },
  'com.venmo':                          { name:'Venmo',            type:'payment', country:'US' },
  'com.squareup.cash':                  { name:'Cash App',         type:'payment', country:'US' },
  'com.zellepay.zelle':                 { name:'Zelle',            type:'payment', country:'US' },
  'com.google.android.apps.walletnfcrel':{ name:'Google Pay',      type:'payment', country:'INT' },
  'com.samsung.android.spay':           { name:'Samsung Pay',      type:'payment', country:'INT' },

  // ─── Europe ───────────────────────────────────────────────────────────────
  'uk.co.hsbc.hsbcukmobilebanking':     { name:'HSBC',             type:'bank',    country:'UK'  },
  'com.barclays.android.barclaysmobilebanking':{ name:'Barclays',  type:'bank',    country:'UK'  },
  'com.lloydsbank.mobile.android':      { name:'Lloyds',           type:'bank',    country:'UK'  },
  'com.natwest.mobilebank':             { name:'NatWest',          type:'bank',    country:'UK'  },
  'com.revolut.revolut':                { name:'Revolut',          type:'neobank', country:'INT' },
  'de.number26.android':                { name:'N26',              type:'neobank', country:'DE'  },
  'co.monzo.android':                   { name:'Monzo',            type:'neobank', country:'UK'  },
  'com.starlingbank.android':           { name:'Starling',         type:'neobank', country:'UK'  },
  'com.commerzbank.mobile':             { name:'Commerzbank',      type:'bank',    country:'DE'  },
  'de.dkb.portalapp':                   { name:'DKB',              type:'bank',    country:'DE'  },
  'com.bnpparibasfortis.easybankingapp':{ name:'BNP Paribas',      type:'bank',    country:'FR'  },
  'com.laposte.lapostemobile':          { name:'La Banque Postale', type:'bank',   country:'FR'  },
  'es.lacaixa.operaciones.android':     { name:'CaixaBank',        type:'bank',    country:'ES'  },
  'com.bbva.bbvacontigo':               { name:'BBVA',             type:'bank',    country:'ES'  },
  'com.bancosantander.empresas':        { name:'Santander ES',     type:'bank',    country:'ES'  },
  'es.santander.particulares':          { name:'Santander ES',     type:'bank',    country:'ES'  },

  // ─── Crypto ───────────────────────────────────────────────────────────────
  'com.coinbase.android':               { name:'Coinbase',         type:'crypto',  country:'INT' },
  'com.binance.dev':                    { name:'Binance',          type:'crypto',  country:'INT' },
  'com.kraken.invest.android':          { name:'Kraken',           type:'crypto',  country:'INT' },
  'piuk.blockchain.android':            { name:'Blockchain.com',   type:'crypto',  country:'INT' },
  'io.metamask':                        { name:'MetaMask',         type:'crypto',  country:'INT' },
  'com.wallet.crypto.trustapp':         { name:'Trust Wallet',     type:'crypto',  country:'INT' },
  'exodusmovement.exodus':              { name:'Exodus',           type:'crypto',  country:'INT' },
  'co.mona.android':                    { name:'Crypto.com',       type:'crypto',  country:'INT' },
  'com.bybit.bits':                     { name:'Bybit',            type:'crypto',  country:'INT' },
  'com.kucoin.exchange':                { name:'KuCoin',           type:'crypto',  country:'INT' },
  'com.okex.androidapp':                { name:'OKX',              type:'crypto',  country:'INT' },
  'network.phantom':                    { name:'Phantom',          type:'crypto',  country:'INT' },
  'io.rainbow':                         { name:'Rainbow Wallet',   type:'crypto',  country:'INT' },
  'com.featurepoints.apptest':          { name:'Uniswap',          type:'crypto',  country:'INT' },
  'org.toshi':                          { name:'Coinbase Wallet',  type:'crypto',  country:'INT' },
  'com.ledger.live':                    { name:'Ledger Live',      type:'crypto',  country:'INT' },
};

// ── Social/messenger apps ─────────────────────────────────────────────────────
const SOCIAL_PKGS = {
  'com.whatsapp':                  { name:'WhatsApp',         type:'messenger' },
  'com.whatsapp.w4b':              { name:'WhatsApp Business',type:'messenger' },
  'org.telegram.messenger':        { name:'Telegram',         type:'messenger' },
  'org.telegram.plus':             { name:'Telegram+',        type:'messenger' },
  'org.thunderdog.challegram':     { name:'Telegram X',       type:'messenger' },
  'com.instagram.android':         { name:'Instagram',        type:'social'    },
  'com.facebook.katana':           { name:'Facebook',         type:'social'    },
  'com.facebook.orca':             { name:'Messenger',        type:'messenger' },
  'com.twitter.android':           { name:'X / Twitter',      type:'social'    },
  'com.zhiliaoapp.musically':      { name:'TikTok',           type:'social'    },
  'com.ss.android.ugc.trill':      { name:'TikTok (Global)',  type:'social'    },
  'com.snapchat.android':          { name:'Snapchat',         type:'social'    },
  'com.discord':                   { name:'Discord',          type:'messenger' },
  'com.linkedin.android':          { name:'LinkedIn',         type:'social'    },
  'com.pinterest':                 { name:'Pinterest',        type:'social'    },
  'com.reddit.frontpage':          { name:'Reddit',           type:'social'    },
  'com.skype.raider':              { name:'Skype',            type:'messenger' },
  'com.viber.voip':                { name:'Viber',            type:'messenger' },
  'org.thoughtcrime.securesms':    { name:'Signal',           type:'messenger' },
  'jp.naver.line.android':         { name:'LINE',             type:'messenger' },
  'com.tencent.mm':                { name:'WeChat',           type:'messenger' },
  'com.kakao.talk':                { name:'KakaoTalk',        type:'messenger' },
  'com.google.android.gm':         { name:'Gmail',            type:'email'     },
  'com.microsoft.office.outlook':  { name:'Outlook',          type:'email'     },
  'com.google.android.youtube':    { name:'YouTube',          type:'social'    },
  'tv.twitch.android.app':         { name:'Twitch',           type:'social'    },
  'com.bereal.ft':                 { name:'BeReal',           type:'social'    },
  'com.instagram.barcelona':       { name:'Threads',          type:'social'    },
  'com.tumblr':                    { name:'Tumblr',           type:'social'    },
  'kik.android':                   { name:'Kik',              type:'messenger' },
  'com.tencent.mobileqq':          { name:'QQ',               type:'messenger' },
  'com.hike.status.sticker':       { name:'Hike',             type:'messenger' },
};

// ── Keyword fallback patterns ─────────────────────────────────────────────────
const FIN_KW   = ['bank','banco','banking','finance','financ','pay','wallet','invest',
                   'credit','debit','loan','prest','crédito','dinheiro','money','cash',
                   'transfer','boleto','pix','cartão','cartao','conta','fintech',
                   'crypto','bitcoin','ethereum','neobank','broker','corretora','fundo'];

const SOCIAL_KW = ['chat','message','social','friend','network','messenger','talk',
                   'connect','community','video','stream','forum','media'];

// ── OTP / 2FA extraction ──────────────────────────────────────────────────────
const OTP_PATTERNS = [
  /\b(\d{4,8})\b.{0,60}(?:code|código|token|otp|senha|pin|verif|autent)/i,
  /(?:code|código|token|otp|pin|verif|autent).{0,60}\b(\d{4,8})\b/i,
  /código[:\s]+(\d{4,8})/i,
  /code[:\s]+(\d{4,8})/i,
  /senha[:\s]+(\d{4,8})/i,
  /token[:\s]+(\d{4,8})/i,
  /\b(\d{6})\b/,   // bare 6-digit code (most common OTP length)
];

function extract2FA(text) {
  if (!text) return null;
  for (const re of OTP_PATTERNS) {
    const m = text.match(re);
    const code = m ? (m[1] || m[2]) : null;
    if (code && code.length >= 4) return code;
  }
  return null;
}

// ── Classification helpers ────────────────────────────────────────────────────
function matchKw(str, kws) {
  const s = str.toLowerCase();
  return kws.some(k => s.includes(k));
}

/**
 * Classify a single app object.
 * @returns {{ category:'financial'|'social'|null, type:string, name:string, detected:'db'|'keyword' }}
 */
function classifyApp(app) {
  const pkg  = (app.package || app.packageName || '').toLowerCase();
  const name = (app.name || app.label || app.appName || '').toLowerCase();

  if (FINANCIAL_PKGS[pkg]) return { ...FINANCIAL_PKGS[pkg], category:'financial', detected:'db' };
  if (SOCIAL_PKGS[pkg])    return { ...SOCIAL_PKGS[pkg],    category:'social',    detected:'db' };
  if (matchKw(name + ' ' + pkg, FIN_KW))   return { name: app.name||pkg, type:'financial', category:'financial', detected:'keyword' };
  if (matchKw(name + ' ' + pkg, SOCIAL_KW)) return { name: app.name||pkg, type:'social',    category:'social',    detected:'keyword' };
  return null;
}

/**
 * Run detection over a full app list.
 * @param {Array} apps
 * @returns {{ financial:Array, social:Array }}
 */
function detectApps(apps) {
  const out = { financial: [], social: [] };
  for (const app of apps) {
    const cls = classifyApp(app);
    if (!cls) continue;
    const entry = {
      package:  app.package || app.packageName || '',
      name:     app.name || app.label || app.appName || cls.name,
      type:     cls.type,
      country:  cls.country || null,
      detected: cls.detected,
    };
    if (cls.category === 'financial') out.financial.push(entry);
    else if (cls.category === 'social') out.social.push(entry);
  }
  return out;
}

module.exports = { detectApps, classifyApp, extract2FA, FINANCIAL_PKGS, SOCIAL_PKGS };
