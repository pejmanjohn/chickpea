import { normalizeDeploymentOrigin } from './origin.ts';

/** The loopback landing page carries no OAuth code, account details, or tokens. */
export function chatgptReturnPage(deployment: string): string {
  const origin = normalizeDeploymentOrigin(deployment).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finish connecting ChatGPT · Chickpea</title>
<link rel="icon" href="${origin}/chickpea-mark-128.png">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:#f4ebd8;color:#3b3220;font-family:"Avenir Next",ui-rounded,system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:520px;padding:38px 40px 32px;background:#fffdf6;border:1px solid #e5dac3;border-radius:28px;box-shadow:0 16px 52px #63502a12}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:38px}.mark{width:44px;height:44px}.wordmark{width:139px;height:auto}
.steps{display:flex;align-items:center;gap:12px;margin-bottom:28px;font-size:13px;font-weight:600;color:#6b5c42}.done{color:#4e7a3e}.current{background:#f7e6bd;border-radius:999px;padding:7px 12px;color:#7b5712}.arrow{color:#ab9a7c}
h1{font-size:34px;line-height:1.15;letter-spacing:-1.1px;margin:0 0 16px;font-weight:750}p{font-size:16px;line-height:1.65;margin:0;color:#6b5c42}
.continue{display:flex;justify-content:center;align-items:center;gap:12px;width:100%;margin-top:30px;padding:15px 20px;background:#dda033;border:1px solid #d1952a;border-radius:13px;box-shadow:0 3px 0 #b27e1f;color:#3b3220;text-decoration:none;font-size:15px;font-weight:750;transition:background .15s}.continue:hover{background:#e5ac44}.continue:focus-visible{outline:3px solid #7b5712;outline-offset:5px}
.note{margin-top:25px;padding-top:23px;border-top:1px solid #e9dfcd;font-size:13px;line-height:1.65;color:#7d6b4f}
@media(max-width:540px){body{padding:24px 16px}main{padding:28px 25px;border-radius:23px}.brand{margin-bottom:30px}h1{font-size:30px}.steps{gap:9px;font-size:12px}}
@media(prefers-reduced-motion:reduce){.continue{transition:none}}
</style></head><body>
<main aria-labelledby="title">
  <div class="brand" aria-label="Chickpea"><img class="mark" src="${origin}/chickpea-mark-128.png" width="44" height="44" alt=""><img class="wordmark" src="${origin}/chickpea-wordmark-512.png" width="139" height="35" alt="Chickpea"></div>
  <div class="steps" aria-label="Next step: confirm your account"><span class="done">✓ Sign in</span><span class="arrow" aria-hidden="true">→</span><span class="current">Confirm account</span></div>
  <h1 id="title">One last step.</h1>
  <p>Head back to Chickpea and confirm your ChatGPT account in <strong>Model providers</strong> to finish connecting.</p>
  <a class="continue" href="${origin}/admin/settings/providers">Continue to Chickpea <span aria-hidden="true">→</span></a>
  <p class="note">Already have Chickpea open? You can switch back to that tab to confirm your account.</p>
</main></body></html>`;
}
