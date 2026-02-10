/* ===== HangHordó PATCH v4: tiszta gombsor + stabil rajz + opcionális auto-upload ===== */
(function () {
  const UI = {
    showHome: true,
    showRefresh: true,
    showDraw: true,
    showSummary: false,

    // Upload gomb megjelenés:
    // "pendingOnly" = csak akkor látszik, ha van függő feltöltés
    // "always" = mindig látszik
    // "off" = soha nem látszik
    uploadButtonMode: "pendingOnly",

    // Befejezés után (mentés gomb megnyomására) automatikus feltöltés próbálkozás:
    autoUploadAfterSave: true,
    autoUploadArmMs: 30000,   // ennyi ideig "figyeli" a mentés gombot a popupban
    autoUploadDelayMs: 700,   // mentés után ennyivel indítja a batch uploadot
  };

  const PATCH = {
    movePxThreshold: 10,
    blockAfterMoveMs: 650,
    blockAfterZoomMs: 900,
    hideMenuButton: true,
  };

  // --- Utils
  const now = () => Date.now();

  function safeClickByText(texts) {
    const wanted = Array.isArray(texts) ? texts : [texts];
    const nodes = Array.from(document.querySelectorAll("button,a"));
    for (const t of wanted) {
      const hit = nodes.find(n => (n.textContent || "").trim() === t);
      if (hit) { hit.click(); return true; }
    }
    return false;
  }

  function guessOfflineQueueCount() {
    const prefer = [
      "hanghordo_offline_queue",
      "offline_queue",
      "offlineQueue",
      "HH_OFFLINE_QUEUE",
      "pending_upload_queue",
    ];
    for (const k of prefer) {
      const v = localStorage.getItem(k);
      if (!v) continue;
      try { const j = JSON.parse(v); if (Array.isArray(j)) return j.length; } catch {}
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (!/queue|pending|offline/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      try { const j = JSON.parse(v); if (Array.isArray(j)) return j.length; } catch {}
    }
    return 0;
  }

  // --- Finish gate: csak “Befejezés” után engedjük lezárni a vonalat
  window.__hhFinishRequested = false;

  function patchLeafletDrawFinishGate() {
    if (!window.L || !L.Draw || !L.Draw.Polyline) return;

    const proto = L.Draw.Polyline.prototype;
    if (proto.__hhFinishGatePatched) return;
    proto.__hhFinishGatePatched = true;

    const origFinish = proto._finishShape;
    if (typeof origFinish === "function") {
      proto._finishShape = function () {
        if (!window.__hhFinishRequested) return;
        window.__hhFinishRequested = false;
        return origFinish.apply(this, arguments);
      };
    }
  }

  function installForMap(map) {
    if (map.__hhPatched4) return;
    map.__hhPatched4 = true;

    patchLeafletDrawFinishGate();

    // Zoom (+/-) top-right (külön oldalon, teljes szélen CSS-ből)
    if (map.zoomControl && typeof map.zoomControl.setPosition === "function") {
      map.zoomControl.setPosition("topright");
    }

    const container = map.getContainer();

    // --- Gesture block
    let blockUntil = 0;
    let drawActive = false;

    const setBlock = (ms) => { blockUntil = Math.max(blockUntil, now() + ms); };
    const isBlocked = () => now() < blockUntil;

    map.on("movestart zoomstart", () => setBlock(PATCH.blockAfterZoomMs));
    map.on("moveend zoomend", () => setBlock(200));

    let startX = 0, startY = 0, moved = false;

    container.addEventListener("touchstart", (e) => {
      moved = false;
      if (e.touches && e.touches.length > 1) setBlock(PATCH.blockAfterZoomMs);
      if (e.touches && e.touches.length >= 1) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    }, { passive: true });

    container.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches.length > 1) setBlock(PATCH.blockAfterZoomMs);
      if (!e.touches || e.touches.length < 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.hypot(dx, dy) > PATCH.movePxThreshold) {
        moved = true;
        setBlock(PATCH.blockAfterMoveMs);
      }
    }, { passive: true });

    container.addEventListener("touchend", () => {
      if (moved) setBlock(300);
      moved = false;
    }, { passive: true });

    // Leaflet-Draw néha touchstart/mousedown alatt rakna pontot -> blokkoljuk, ha mozgás/zoom után vagyunk
    ["mousedown", "touchstart"].forEach((evt) => {
      container.addEventListener(evt, (e) => {
        if (!drawActive) return;
        if (!isBlocked()) return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      }, { capture: true, passive: false });
    });

    // --- Draw handler
    let drawHandler = null;

    function ensureDrawHandler() {
      if (drawHandler) return drawHandler;
      if (!window.L || !L.Draw || !L.Draw.Polyline) return null;
      drawHandler = new L.Draw.Polyline(map, { shapeOptions: { weight: 4 } });
      return drawHandler;
    }

    // Quick button refek (később kapnak értéket)
    let quickDrawBtn = null;
    let quickUploadBtn = null;
    let quickUploadBadge = null;

    function setDraw(on) {
      const h = ensureDrawHandler();
      if (!h) return;

      if (on) {
        patchLeafletDrawFinishGate();
        h.enable();
        drawActive = true;
        document.body.classList.add("hh-draw-active");
        if (quickDrawBtn) quickDrawBtn.classList.add("hh-active");
      } else {
        h.disable();
        drawActive = false;
        document.body.classList.remove("hh-draw-active");
        if (quickDrawBtn) quickDrawBtn.classList.remove("hh-active");
      }
    }

    // --- Auto upload arm (Befejezés után mentés gomb kattintására)
    let autoUploadArmedUntil = 0;

    function armAutoUpload() {
      if (!UI.autoUploadAfterSave) return;
      autoUploadArmedUntil = now() + UI.autoUploadArmMs;
    }
    function disarmAutoUpload() { autoUploadArmedUntil = 0; }

    document.addEventListener("click", (e) => {
      if (!UI.autoUploadAfterSave) return;
      if (autoUploadArmedUntil === 0 || now() > autoUploadArmedUntil) return;

      const btn = e.target.closest("button,a");
      if (!btn) return;

      const t = (btn.textContent || "").trim().toLowerCase();

      // Itt csak “mentés jellegű” gombokra lőjünk
      const isSave =
        t === "mentés" ||
        t.includes("mentés") ||
        t.includes("rögzít") ||
        t === "ok" ||
        t === "kész";

      const isCancel =
        t.includes("mégse") ||
        t.includes("bezár") ||
        t.includes("cancel");

      if (isCancel) {
        disarmAutoUpload();
        return;
      }

      if (!isSave) return;

      disarmAutoUpload();

      setTimeout(() => {
        if (!navigator.onLine) return;
        if (typeof window.handleBatchUpload === "function") window.handleBatchUpload();
      }, UI.autoUploadDelayMs);
    }, true);

    function finishDraw() {
      const h = ensureDrawHandler();
      if (!h || !h.enabled || !h.enabled()) return;

      armAutoUpload();

      window.__hhFinishRequested = true;
      if (typeof h.completeShape === "function") h.completeShape();
      else if (typeof h._finishShape === "function") h._finishShape();
    }

    function undoLast() {
      const h = ensureDrawHandler();
      if (!h || !h.enabled || !h.enabled()) return;
      if (typeof h.deleteLastVertex === "function") h.deleteLastVertex();
    }

    function cancelDraw() {
      disarmAutoUpload();
      setDraw(false);
    }

    map.on("draw:created", () => {
      drawActive = false;
      document.body.classList.remove("hh-draw-active");
      if (quickDrawBtn) quickDrawBtn.classList.remove("hh-active");
      // autoUpload arm itt maradhat (a modal mentésére várunk)
    });

    // --- Alsó rajz-sáv
    const bar = document.createElement("div");
    bar.className = "hh-drawbar";
    bar.innerHTML = `
      <button type="button" data-act="finish">Befejezés</button>
      <button type="button" data-act="undo">Vissza</button>
      <button type="button" class="hh-warn" data-act="cancel">Mégse</button>
    `;
    document.body.appendChild(bar);

    bar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === "finish") finishDraw();
      if (act === "undo") undoLast();
      if (act === "cancel") cancelDraw();
    });

    // --- Gyorsgombok (Home/Refresh/Draw/Upload)
    function quickBtn(act, title, label, badge) {
      return `<a href="#" title="${title}" data-act="${act}">${label}${badge ? '<span class="hh-badge">0</span>' : ""}</a>`;
    }

    const Quick = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        const div = L.DomUtil.create("div", "leaflet-control hh-quick leaflet-bar");

        const parts = [];
        if (UI.showHome) parts.push(quickBtn("home", "Főmenü", "⌂", false));
        if (UI.showRefresh) parts.push(quickBtn("refresh", "Frissítés", "⟳", false));
        if (UI.showDraw) parts.push(quickBtn("draw", "Rajzolás", "✎", false)); // nem emoji, jobban skálázódik

        if (UI.uploadButtonMode !== "off") {
          parts.push(quickBtn("upload", "Feltöltés", "⇧", true)); // nem emoji
        }

        if (UI.showSummary) parts.push(quickBtn("summary", "Összesítés", "Σ", false));

        div.innerHTML = parts.join("");
        L.DomEvent.disableClickPropagation(div);

        quickDrawBtn = div.querySelector('a[data-act="draw"]');
        quickUploadBtn = div.querySelector('a[data-act="upload"]');
        quickUploadBadge = quickUploadBtn ? quickUploadBtn.querySelector(".hh-badge") : null;

        div.addEventListener("click", (e) => {
          const a = e.target.closest("a[data-act]");
          if (!a) return;
          e.preventDefault();

          const act = a.dataset.act;

          if (act === "draw") setDraw(!drawActive);

          if (act === "refresh") {
            if (typeof window.loadAllRoutes === "function") window.loadAllRoutes();
            else location.reload();
          }

          if (act === "upload") {
            if (typeof window.handleBatchUpload === "function") window.handleBatchUpload();
            else safeClickByText(["Szórólapozás manuális feltöltése", "Manuális feltöltés", "Feltöltés"]);
          }

          if (act === "summary") {
            if (typeof window.showSummary === "function") window.showSummary();
            else safeClickByText(["Összesítés", "Osszesites"]);
          }

          if (act === "home") {
            safeClickByText(["Vissza a főmenübe", "Főmenü", "Main menu"]);
          }
        });

        return div;
      },
    });

    map.addControl(new Quick());

    function refreshUploadUI() {
      if (!quickUploadBtn || !quickUploadBadge) return;

      const n = guessOfflineQueueCount();
      quickUploadBadge.textContent = String(n);
      quickUploadBadge.style.display = n > 0 ? "inline-block" : "none";

      if (UI.uploadButtonMode === "pendingOnly") {
        quickUploadBtn.style.display = n > 0 ? "" : "none";
      } else {
        quickUploadBtn.style.display = "";
      }
    }

    refreshUploadUI();
    setInterval(refreshUploadUI, 1500);
    window.addEventListener("storage", refreshUploadUI);

    // Menü gomb elrejtése
    function hideMenuButton() {
      if (!PATCH.hideMenuButton) return;
      const els = Array.from(document.querySelectorAll("button,a"))
        .filter(el => {
          const t = (el.textContent || "").trim().toLowerCase();
          return t === "menü" || t === "menu";
        });
      els.forEach(el => { el.style.display = "none"; });
    }
    hideMenuButton();
    setTimeout(hideMenuButton, 800);
  }

  function bootstrap() {
    if (!window.L || !L.Map || !L.Map.addInitHook) {
      setTimeout(bootstrap, 50);
      return;
    }
    L.Map.addInitHook(function () {
      try { installForMap(this); } catch (e) { console.error("HH patch error:", e); }
    });
  }

  bootstrap();
})();
