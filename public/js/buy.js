/* LICENSE402 /buy — wallet checkout. External file (strict CSP: script-src 'self').
   Wallet connect lives in the header (industry-standard top-right). */
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const short = (v) => (!v ? "—" : String(v).length > 18 ? String(v).slice(0, 10) + "…" + String(v).slice(-6) : String(v));
  const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 3600); };
  const err = (n, m) => { const e = $("#err" + n); if (!m) { e.style.display = "none"; return; } e.textContent = m; e.style.display = "block"; };
  const USE = (b) => ({ brief: b, channel: "x", commercial: true, durationDays: 14, territory: "worldwide", transformations: ["crop", "overlay_text"], maxBudget: "0.10" });

  // rail parameters (asset addresses come from /config.json at boot)
  const RAILS = {
    mainnet: { chainHex: "0xc4", chainId: 196, network: "eip155:196", name: "X Layer", rpc: "https://rpc.xlayer.tech", explorer: "https://www.oklink.com/x-layer/tx/", asset: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", label: "eip155:196 · X Layer" },
    testnet: { chainHex: "0x7a0", chainId: 1952, network: "eip155:1952", name: "X Layer Testnet", rpc: "https://testrpc.xlayer.tech", explorer: "https://www.oklink.com/x-layer-test/tx/", asset: "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c", label: "eip155:1952 · X Layer Testnet" }
  };

  let eth = null, ACC = null, CFG = null, QUOTE = null, RESULT = null;
  let RAIL = new URLSearchParams(location.search).get("network") === "testnet" ? "testnet" : "mainnet";
  const PIN_OFFER = new URLSearchParams(location.search).get("offerId") || null;

  const rail = () => RAILS[RAIL];
  const setStep = (n) => { document.querySelectorAll(".step").forEach((s) => { const k = Number(s.dataset.s); s.classList.toggle("done", k < n); s.classList.toggle("on", k === n); }); };
  const unlock = (id) => { $(id).classList.remove("locked"); };
  const lock = (id) => { $(id).classList.add("locked"); };

  async function api(p, opt, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 20000);
    try {
      const r = await fetch(p, { ...(opt || {}), signal: ctl.signal });
      const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
      return { status: r.status, json: j, headers: r.headers };
    } finally { clearTimeout(timer); }
  }
  // Wallet prompts can sit unanswered forever — surface that instead of hanging.
  function withWalletTimeout(promise, what) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("Waiting on your wallet — please confirm the " + what + " prompt in the wallet extension, then retry.")), 25000))
    ]);
  }

  // ---- rail switching -------------------------------------------------------
  function applyRail() {
    document.querySelectorAll(".railopt").forEach((b) => b.classList.toggle("on", b.dataset.rail === RAIL));
    $("#envNet").textContent = rail().label;
    $("#envToken").textContent = (RAIL === "testnet" ? "test USDT (USD₮0) · " : "USDT (USD₮0) · ") + short(rail().asset);
    $("#subFund").textContent = RAIL === "testnet" ? "free test USDT via faucet" : "0.10 USDT · self-funded";
    $("#fundMainnet").style.display = RAIL === "mainnet" ? "block" : "none";
    $("#fundTestnet").style.display = RAIL === "testnet" ? "block" : "none";
    $("#btnBuy").textContent = RAIL === "testnet" ? "Sign & pay 0.10 test USDT" : "Sign & pay 0.10 USDT";
    resetCheckout("rail");
  }
  document.querySelectorAll(".railopt").forEach((b) => b.addEventListener("click", () => {
    if (b.disabled) return;
    RAIL = b.dataset.rail; applyRail();
  }));

  // Any identity/network change invalidates in-flight terms (review §6.1).
  function resetCheckout(reason) {
    QUOTE = null; $("#quoteBox").innerHTML = "";
    $("#sigIntentTxt").textContent = "—"; $("#sigPayTxt").textContent = "—";
    $("#sigIntentTxt").classList.remove("ok"); $("#sigPayTxt").classList.remove("ok");
    $("#btnBuy").disabled = false;
    lock("#p2"); lock("#p3");
    setStep(1);
    if (reason === "account") toast("Wallet changed — terms reset, get a fresh quote");
    if (ACC) refreshBalance();
  }

  // ---- header wallet button (standard top-right connect) --------------------
  async function ensureChain() {
    const current = await eth.request({ method: "eth_chainId" }).catch(() => null);
    if (String(current).toLowerCase() === rail().chainHex) return; // already there — no prompt
    try {
      await withWalletTimeout(eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: rail().chainHex }] }), "network switch");
    } catch (sw) {
      if (sw && (sw.code === 4902 || /unrecognized|not added/i.test(String(sw.message || "")))) {
        await withWalletTimeout(eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: rail().chainHex, chainName: rail().name, nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: [rail().rpc], blockExplorerUrls: ["https://www.oklink.com/"] }] }), "add-network");
      } else { throw sw; }
    }
    const chainId = await eth.request({ method: "eth_chainId" });
    if (String(chainId).toLowerCase() !== rail().chainHex) throw new Error("Wrong network — please approve the switch to " + rail().name + " in your wallet");
  }

  async function connect() {
    eth = (window.okxwallet && (window.okxwallet.provider || window.okxwallet)) || window.ethereum;
    if (!eth) { toast("No wallet extension — install OKX Wallet or MetaMask"); window.open("https://web3.okx.com/download", "_blank"); return; }
    try {
      const accs = await eth.request({ method: "eth_requestAccounts" });
      ACC = accs[0];
      ensureChain().catch(() => {}); // best-effort: signing works from ANY chain
      onConnected();
      if (eth.on) {
        eth.on("accountsChanged", (a) => { ACC = a && a[0] ? a[0] : null; if (!ACC) { disconnectedUi(); } else { onConnected(); resetCheckout("account"); } });
        eth.on("chainChanged", () => { resetCheckout("chain"); });
      }
    } catch (e) { toast(e && e.message ? String(e.message).slice(0, 120) : "Connection rejected"); }
  }
  function onConnected() {
    const btn = $("#walletBtn");
    btn.classList.add("connected");
    btn.innerHTML = '<span class="dot"></span><span>' + short(ACC) + '</span><span class="bal" id="walletBal"></span>';
    $("#fundAcct").textContent = ACC;
    $("#selfAddr").textContent = ACC;
    if (QUOTE) { unlock("#p2"); setStep(2); }
    refreshBalance();
  }
  function disconnectedUi() {
    const btn = $("#walletBtn");
    btn.classList.remove("connected");
    btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 12h4"/><path d="M2 10h20"/></svg><span>Connect wallet</span>';
    resetCheckout("account");
  }
  $("#walletBtn").addEventListener("click", () => { if (!ACC) connect(); else toast("Connected: " + ACC); });

  // ---- balances (read via the wallet provider on the SELECTED rail) ---------
  async function refreshBalance() {
    if (!ACC) return 0n;
    try {
      // Server-side read: correct regardless of which chain the wallet is on.
      const r = await api("/v1/balance/" + ACC + (RAIL === "testnet" ? "?network=testnet" : ""), undefined, 15000);
      if (!(r.json && typeof r.json.balanceMicro === "number")) throw new Error("balance unavailable");
      const bal = BigInt(r.json.balanceMicro);
      const label = (Number(bal) / 1e6).toFixed(2) + (RAIL === "testnet" ? " tUSDT" : " USDT");
      $("#balTxt").textContent = label;
      const wb = $("#walletBal"); if (wb) wb.textContent = label;
      if (bal >= 100000n) { $("#balTxt").classList.add("ok"); if (QUOTE) { unlock("#p3"); setStep(3); } }
      else { $("#balTxt").classList.remove("ok"); }
      return bal;
    } catch (e) {
      $("#balTxt").textContent = "(balance check failed)";
      return 0n;
    }
  }
  $("#recheckBal").addEventListener("click", refreshBalance);
  // Skip the faucet entirely when the wallet is already funded (any rail).
  $("#skipFaucet").addEventListener("click", async () => {
    err(2, "");
    if (!ACC) { err(2, "Connect your wallet first (top right)"); return; }
    const bal = await refreshBalance();
    if (bal < 100000n) err(2, "This wallet holds less than 0.10 test USDT on X Layer testnet — claim the free grant or fund it, then retry.");
  });
  $("#copyAddr").addEventListener("click", () => { if (ACC) navigator.clipboard.writeText(ACC).then(() => toast("Address copied")); });

  // ---- testnet faucet --------------------------------------------------------
  $("#btnFaucet").addEventListener("click", async () => {
    err(2, "");
    if (!ACC) { err(2, "Connect your wallet first (top right)"); return; }
    if (RAIL !== "testnet") { err(2, "The faucet serves testnet only"); return; }
    const b = $("#btnFaucet"); b.disabled = true;
    try {
      b.textContent = "Requesting grant…";
      const r = await api("/v1/faucet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: ACC }) }, 60000);
      if (r.json && r.json.ok) {
        toast((r.json.amount || "10") + " test USDT sent — confirming on-chain");
        b.textContent = "Waiting for confirmation…";
        for (let i = 0; i < 10; i++) { const bal = await refreshBalance(); if (bal >= 100000n) { toast("Funded ✓"); break; } await new Promise((r2) => setTimeout(r2, 3000)); }
      } else err(2, (r.json && (r.json.detail || r.json.error)) || "Faucet unavailable");
    } catch (e) { err(2, e && e.message ? String(e.message).slice(0, 180) : "Faucet request failed"); }
    finally { b.disabled = false; b.textContent = "Claim 10 test USDT — free"; }
  });

  // ---- 01 review / quote -----------------------------------------------------
  async function getQuote() {
    err(1, ""); $("#btnQuote").disabled = true;
    try {
      const body = { use: USE($("#brief").value), licenseeWallet: ACC || "0x0000000000000000000000000000000000000001" };
      if (RAIL === "testnet") body.network = "testnet";
      if (PIN_OFFER) body.requestedOfferId = PIN_OFFER;
      const r = await api("/v1/quote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!(r.json && r.json.serviceable)) {
        err(1, (PIN_OFFER ? "This exact offer is not eligible for that use: " : "Not serviceable: ") + ((r.json && r.json.reasons || []).join(", ") || "no eligible offer"));
        $("#btnQuote").disabled = false; return;
      }
      QUOTE = r.json;
      const a = QUOTE.asset;
      const img = a.previewUrl || a.watermarkedPreviewUrl; // canonical + legacy alias
      const card = document.createElement("div"); card.className = "assetcard";
      const im = document.createElement("img"); im.src = img; im.alt = a.title;
      const inn = document.createElement("div"); inn.className = "in";
      const t = document.createElement("div"); t.className = "t"; t.textContent = a.title;
      const c = document.createElement("div"); c.className = "c"; c.textContent = "by " + (a.creator || "Genesis Studio") + " · " + short(a.assetSha256);
      const chips = document.createElement("div"); chips.className = "chips";
      [["Commercial X post", 1], ["Crop", 1], ["Add text", 1], ["Worldwide", 1], ["14 days", 1], ["Model training", 0], ["Resale", 0]].forEach(([label, ok]) => {
        const ch = document.createElement("span"); ch.className = "chip" + (ok ? "" : " no"); ch.textContent = label; chips.appendChild(ch);
      });
      const price = document.createElement("div"); price.className = "price";
      price.innerHTML = "<b>0.10 " + (RAIL === "testnet" ? "test USDT" : "USDT") + "</b> · creator 0.07 · platform 0.03 · quote expires " + new Date(QUOTE.purchaseIntentFields.expiresAt * 1000).toLocaleTimeString();
      inn.append(t, c, chips, price); card.append(im, inn);
      $("#quoteBox").innerHTML = ""; $("#quoteBox").appendChild(card);
      unlock("#p2"); setStep(2);
      if (ACC) refreshBalance();
    } catch (e) { err(1, "Quote failed"); }
    $("#btnQuote").disabled = false;
  }
  $("#btnQuote").addEventListener("click", getQuote);

  // ---- 03 sign & pay ---------------------------------------------------------
  function randNonce() { const b = new Uint8Array(32); crypto.getRandomValues(b); return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
  const CK_KEY = "license402.checkout.v1";

  $("#btnBuy").addEventListener("click", async () => {
    err(3, "");
    if (!QUOTE) { err(3, "Get the quote first"); return; }
    if (!ACC) { err(3, "Connect your wallet (top right)"); return; }
    const btn = $("#btnBuy"); btn.disabled = true;
    try {
      const f = QUOTE.purchaseIntentFields, td = QUOTE.eip712;
      if (f.licensee && f.licensee.toLowerCase() !== ACC.toLowerCase()) {
        // quote was taken before connecting / for another account — refresh it
        await getQuote();
        if (!QUOTE) throw new Error("Re-quote failed");
      }
      const f2 = QUOTE.purchaseIntentFields;
      const nonce = randNonce();
      const message = { quoteId: f2.quoteId, quoteCommitment: f2.quoteCommitment, buyer: ACC, licensee: ACC, assetSha256: f2.assetSha256, offerDigest: f2.offerDigest, policyAstHash: f2.policyAstHash, legalTextHash: f2.legalTextHash, totalPriceMicro: "100000", currency: "USDT", settlementNetwork: f2.settlementNetwork, paymentAsset: f2.paymentAsset, payTo: f2.payTo, creatorPayoutMicro: String(f2.creatorPayoutMicro), platformFeeMicro: String(f2.platformFeeMicro), expiresAt: f2.expiresAt, nonce };
      btn.textContent = "Signature 1/2 — terms…";
      const sig = await eth.request({ method: "eth_signTypedData_v4", params: [ACC, JSON.stringify({ domain: td.domain, types: td.types, primaryType: "PurchaseIntent", message })] });
      $("#sigIntentTxt").textContent = short(sig) + " ✓"; $("#sigIntentTxt").classList.add("ok");
      const intent = { quoteId: f2.quoteId, quoteCommitment: f2.quoteCommitment, buyer: ACC.toLowerCase(), licensee: ACC.toLowerCase(), assetSha256: f2.assetSha256, offerDigest: f2.offerDigest, policyAstHash: f2.policyAstHash, legalTextHash: f2.legalTextHash, totalPrice: f2.totalPrice, currency: "USDT", settlementNetwork: f2.settlementNetwork, paymentAsset: f2.paymentAsset, payTo: f2.payTo, creatorPayoutMicro: f2.creatorPayoutMicro, platformFeeMicro: f2.platformFeeMicro, expiresAt: f2.expiresAt, nonce, signature: sig };

      const bodyObj = { use: USE($("#brief").value), licenseeWallet: ACC, quoteCommitment: QUOTE.quoteCommitment, idempotencyKey: QUOTE.idempotencyKey, purchaseIntent: intent };
      if (RAIL === "testnet") bodyObj.network = "testnet";
      const body = JSON.stringify(bodyObj);
      const hdr = { "content-type": "application/json" };

      btn.textContent = "Requesting 402 challenge…";
      let r = await api("/v1/acquire/social-commercial", { method: "POST", headers: hdr, body });
      let payHeaders = null;
      if (r.status === 402) {
        btn.textContent = "Signature 2/2 — payment…";
        // Business preflight: the challenge must match the displayed terms.
        payHeaders = await L402PAY.buildPaymentHeaders(r.json, eth, ACC, { network: rail().network, asset: rail().asset, amount: "100000" });
        $("#sigPayTxt").textContent = "authorized ✓"; $("#sigPayTxt").classList.add("ok");
        // Crash recovery: persist BEFORE the settle round-trip. Replays are
        // idempotent server-side (same authorization → same delivery).
        sessionStorage.setItem(CK_KEY, JSON.stringify({ rail: RAIL, account: ACC, body: bodyObj, payHeaders }));
        btn.textContent = "Settling on " + rail().name + "…";
        r = await api("/v1/acquire/social-commercial", { method: "POST", headers: { ...hdr, ...payHeaders }, body });
      }
      if (r.status === 200) { sessionStorage.removeItem(CK_KEY); onDelivered(r); }
      else if (r.status === 202) { persistPending(r.json); onPending(r.json); }
      else { err(3, (r.json && (r.json.detail || r.json.error)) || "HTTP " + r.status); btn.textContent = RAIL === "testnet" ? "Sign & pay 0.10 test USDT" : "Sign & pay 0.10 USDT"; btn.disabled = false; }
    } catch (e) { err(3, e && e.message ? String(e.message).slice(0, 220) : "Purchase failed"); btn.textContent = RAIL === "testnet" ? "Sign & pay 0.10 test USDT" : "Sign & pay 0.10 USDT"; btn.disabled = false; }
  });

  function persistPending(j) {
    sessionStorage.setItem(CK_KEY, JSON.stringify({ rail: RAIL, account: ACC, pending: { orderId: j.orderId, deliveryUrl: j.deliveryUrl, statusUrl: j.statusUrl } }));
  }

  // ---- delivery / receipt ----------------------------------------------------
  function setText(id, v) { $(id).textContent = v; }
  function onDelivered(r) {
    RESULT = r.json;
    setStep(5);
    const testnet = RAIL === "testnet" || (RESULT.license && String(RESULT.license.orderId || "").length && false);
    const rec = $("#receipt");
    rec.classList.toggle("testnet", RAIL === "testnet");
    $("#receiptBand").textContent = RAIL === "testnet" ? "LICENSE402 · TESTNET LICENSE · SETTLED ON X LAYER TESTNET" : "LICENSE402 · LIVE LICENSE · SETTLED ON X LAYER";
    $("#rStatus").textContent = RAIL === "testnet" ? "LICENSE ACTIVE · TESTNET (TEST VALUE)" : "LICENSE ACTIVE · PRODUCTION";
    const pResp = r.headers.get("payment-response");
    const dec = pResp && window.L402PAY ? L402PAY.decodePaymentResponse(pResp) : null;
    setText("#rTitle", (QUOTE && QUOTE.asset && QUOTE.asset.title) || "Licensed asset");
    const tx = RESULT.settlement && RESULT.settlement.buyerTx;
    if (tx) { const a = document.createElement("a"); a.href = rail().explorer + tx; a.target = "_blank"; a.rel = "noopener"; a.textContent = short(tx) + " ↗ OKLink"; $("#rTx").innerHTML = ""; $("#rTx").appendChild(a); }
    setText("#rPResp", dec ? "status " + dec.status + " · " + (dec.network || "") : (pResp ? "present" : "—"));
    setText("#rOrder", RESULT.orderId);
    setText("#rLicensee", short(ACC));
    $("#rPrice").innerHTML = "<b>0.10 " + (RAIL === "testnet" ? "test USDT" : "USDT") + "</b>";
    rec.style.display = "block";
    rec.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(RAIL === "testnet" ? "Testnet license active — full loop, zero cost" : "License active — settled on X Layer");
    liveChecks(); pollPayout();
  }
  function onPending(j) {
    $("#pendingBox").style.display = "block";
    $("#pendingBox").textContent = "Settlement is " + ((j.settlement && j.settlement.status) || "PENDING") + " — the reconciler confirms it on-chain. This page (and a reload) resumes automatically.";
    resumePending(j);
  }
  function resumePending(j) {
    const ticket = j.deliveryUrl; if (!ticket) return;
    let tries = 0;
    const iv = setInterval(async () => {
      tries++;
      try {
        const d = await api(ticket.replace(location.origin, ""));
        if (d.status === 200) { clearInterval(iv); sessionStorage.removeItem(CK_KEY); $("#pendingBox").style.display = "none"; onDelivered(d); return; }
      } catch (e) { /* retry */ }
      if (tries > 45) { clearInterval(iv); $("#pendingBox").textContent = "Still pending — keep the order link: " + j.statusUrl; }
    }, 4000);
  }
  async function liveChecks() {
    if (!RESULT || !RESULT.license) return;
    const chk = async (action) => { const r = await api("/v1/check-license-scope", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ license: RESULT.license, action, channel: "x", licensee: ACC }) }); return (r.json && (r.json.effectiveDecision || r.json.decision)) || "—"; };
    const post = await chk("commercial_social_post");
    setText("#rChkPost", post);
    if (post === "PERMITTED" || post === "PERMITTED_WITH_DUTIES" || post === "PERMITTED_TESTNET_ONLY") $("#rChkPost").classList.add("ok");
    setText("#rChkTrain", await chk("model_training"));
  }
  async function pollPayout() {
    for (let i = 0; i < 15; i++) {
      try {
        const o = await api("/v1/orders/" + RESULT.orderId);
        const p = o.json && o.json.creatorPayout;
        if (p && p.state === "PAID") {
          const a = document.createElement("a"); a.href = rail().explorer + p.confirmedTx; a.target = "_blank"; a.rel = "noopener"; a.textContent = "paid ↗";
          $("#rPayout").innerHTML = "0.07 · "; $("#rPayout").appendChild(a); return;
        }
      } catch (e) { /* retry */ }
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const dl = (name, obj) => { const b = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };
  $("#rDlAsset").addEventListener("click", () => { if (RESULT && RESULT.asset && RESULT.asset.url) window.open(RESULT.asset.url, "_blank"); });
  $("#rDlCred").addEventListener("click", () => { if (RESULT && RESULT.license) dl(RESULT.license.licenseId + ".license402.json", RESULT.license); });
  $("#rDlBundle").addEventListener("click", async () => { if (!RESULT) return; try { const b = await api("/v1/orders/" + RESULT.orderId + "/bundle"); dl("proof-bundle-" + RESULT.orderId + ".json", b.json); } catch (e) { toast("Bundle unavailable"); } });
  $("#rOrderLink").addEventListener("click", () => { if (RESULT) window.open("/v1/orders/" + RESULT.orderId, "_blank"); });

  // ---- boot -------------------------------------------------------------------
  async function boot() {
    try {
      CFG = (await api("/config.json")).json;
      if (CFG && CFG.rails) {
        if (CFG.rails.mainnet && CFG.rails.mainnet.asset) RAILS.mainnet.asset = CFG.rails.mainnet.asset;
        if (CFG.rails.testnet && CFG.rails.testnet.asset) RAILS.testnet.asset = CFG.rails.testnet.asset;
        if (!CFG.rails.testnet) { const b = $("#railTestnet"); b.disabled = true; b.querySelector(".s").textContent = "testnet rail not enabled on this deployment yet"; if (RAIL === "testnet") RAIL = "mainnet"; }
      }
    } catch (e) { /* defaults hold */ }
    try { const v = (await api("/version.json")).json; if (v && v.commit) $("#footBuild").textContent = "build " + String(v.commit).slice(0, 7); } catch (e) { /* dev */ }
    if (CFG && CFG.listingUrl) { const n = document.createElement("a"); n.href = CFG.listingUrl; n.target = "_blank"; n.rel = "noopener"; n.className = "hint"; n.style.color = "var(--proof)"; n.textContent = "Also listed on OKX.AI — hire this service in the agent marketplace ↗"; const h = document.querySelector(".head p"); if (h) h.after(n); }
    applyRail();
    setStep(1);
    // pinned offer from the market → show its exact title in the note
    if (PIN_OFFER) {
      $("#reviewNote").textContent = "This purchase is pinned to the exact offer you picked in the market (" + PIN_OFFER + "). The engine will not substitute another asset; if this offer can't serve the use, the quote refuses.";
      try {
        const cat = (await api("/v1/catalog")).json;
        const hit = (cat.offers || []).find((o) => "off-" + o.assetId.replace(/^asset-/, "") === PIN_OFFER || o.assetId === PIN_OFFER);
        if (hit) $("#brief").value = hit.title + " — " + (hit.tags || []).join(", ");
      } catch (e) { /* keep default brief */ }
      getQuote();
    }
    // crash/refresh recovery (review §6.2)
    const saved = sessionStorage.getItem(CK_KEY);
    if (saved) {
      try {
        const ck = JSON.parse(saved);
        RAIL = ck.rail || RAIL; applyRail();
        if (ck.pending && ck.pending.deliveryUrl) {
          $("#pendingBox").style.display = "block";
          $("#pendingBox").textContent = "Resuming your pending order " + ck.pending.orderId + "…";
          resumePending(ck.pending);
        } else if (ck.body && ck.payHeaders) {
          // payment was authorized before the reload — replay is idempotent
          toast("Resuming your purchase…");
          const r = await api("/v1/acquire/social-commercial", { method: "POST", headers: { "content-type": "application/json", ...ck.payHeaders }, body: JSON.stringify(ck.body) });
          ACC = ck.account;
          if (r.status === 200) { sessionStorage.removeItem(CK_KEY); QUOTE = QUOTE || { asset: { title: "Licensed asset" }, purchaseIntentFields: {} }; onDelivered(r); }
          else if (r.status === 202) { persistPending(r.json); onPending(r.json); }
        }
      } catch (e) { sessionStorage.removeItem(CK_KEY); }
    }
  }
  boot();
})();
