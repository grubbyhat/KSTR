/* Public site config: edit this when you deploy.
 *
 * KSTR_API: where the live data comes from.
 *   "" (empty)  -> same origin (works when the backend serves this site locally)
 *   "https://your-tunnel.trycloudflare.com" -> the engine's public URL when hosted
 * The site polls KSTR_API + "/api/state" every few seconds (CORS is open on the backend).
 */
window.KSTR_API = '';

window.KSTR_LINKS = {
  contract: '', // KSTR mint (paste at launch). Shows "soon" until set.
  pumpfun: '', // KSTR pump.fun page (fill at launch). Buy button hides until set.
  x: 'https://x.com/KintaraStrategy',
  game: 'https://kintara.gg',
  gold: 'https://kintaragold.xyz',
};
