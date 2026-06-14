/* Public site config — edit this when you deploy.
 *
 * KSTR_API: where the live data comes from.
 *   • ""  (empty)  -> same origin (works when the backend serves this site locally)
 *   • "https://your-tunnel.trycloudflare.com"  -> your engine's public URL when hosted
 *     (run a Cloudflare Tunnel / ngrok to the backend on port 8790, paste the https URL)
 *
 * The site polls KSTR_API + "/api/state" every few seconds (CORS is open on the backend),
 * so it reflects live numbers from wherever the engine runs.
 */
window.KSTR_API = '';

window.KSTR_LINKS = {
  pumpfun: '', // KSTR pump.fun page (fill at launch) — Buy button hides until set
  x: 'https://x.com/PlayKintara',
  game: 'https://kintara.gg',
  gold: 'https://kintaragold.xyz',
};
