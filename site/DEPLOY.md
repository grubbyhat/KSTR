# Hosting the KSTR public site

This folder (`kstr/site/`) is a self-contained static site. It shows the project
info **and** reflects live numbers by polling the engine's `/api/state`.

## 1. Make the engine reachable from the internet
The site needs a public URL for the backend (which runs locally with your wallet).
Easiest: a tunnel from the machine running the engine.

```
# install cloudflared once, then:
cloudflared tunnel --url http://localhost:8790
```
Copy the `https://xxxx.trycloudflare.com` URL it prints. (ngrok works too:
`ngrok http 8790`.) The wallet/keys stay on your machine — the tunnel only exposes
the read-only HTTP API.

## 2. Point the site at it
Edit `config.js`:
```js
window.KSTR_API = 'https://xxxx.trycloudflare.com';   // your tunnel URL
window.KSTR_LINKS = { pumpfun: 'https://pump.fun/coin/<KSTR_MINT>', x: '...', game: '...', gold: '...' };
```

## 3. Deploy the folder
Drag-and-drop `kstr/site/` to any static host:
- **Cloudflare Pages** / **Netlify**: drop the folder, done.
- **Vercel**: `vercel deploy` from this folder (it's static, no build step).
- **GitHub Pages**: push the folder to a repo, enable Pages.

That's it — the deployed site polls your tunnel every 5s and stays in sync.

## Notes
- Served locally too: the backend mounts this folder at `http://localhost:8790/site/`.
- If `KSTR_API` is empty, the site uses same-origin (works when served by the backend).
- For a permanent always-on site, run the engine on a small VPS instead of a tunnel,
  or have the engine push snapshots to a Cloudflare Worker + KV the site reads.
