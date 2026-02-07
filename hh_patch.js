/* ===== HangHordó PATCH v2: 1 rajz ikon + finish csak gombbal + mobilbarát mozgatás ===== */
(function () {
  const PATCH = {
    movePxThreshold: 10,
    blockAfterMoveMs: 700,
    blockAfterZoomMs: 900,
    hideMenuButton: true, // ha zavar, állítsd false-ra
  };

  function now() { return Date.now(); }

  function safeClickByText(texts) {
    const wanted = Array.isArray(texts) ? texts : [texts];
    const nodes = Array.from(document.querySelectorAll("button,a,div,span"));
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

  // === Globális FINISH gate: csak akkor fejezhet be a draw, ha ezt true-ra tesszük
  window.__hhFinishRequested = false;

  function patchLeafletDrawFinishGate() {
    if (!window.L || !L.Draw || !L.Draw.Polyline) return;

    const proto = L.Draw.Polyline.prototype;
    if (proto.__hhFinishGatePatched) return;
    proto.__hhFinishGatePatched = true;

    const origFinish = proto._finishShape;
    if (typeof origFinish === "function") {
      proto._finishShape = function () {
        // Ha nem mi kértük a befejezést, ne engedje lezárni (ez volt a 2 pont utáni popup oka)
        if (!window.__hhFinishRequested) return;
        window.__hhFinishRequested = false; // egyszeri engedély
        return origFinish.apply(this, arguments);
      };
    }
  }

  function installForMap(map) {
    if (map.__hhPatched2) return;
    map.__hhPatched2 = true;

    patchLeafletDrawFinishGate();

    const container = map.getContainer();

    // ===== 1) Blokkolás: mozgatás/zoom/pinch után ne legyen “véletlen pont”
    let blockUntil = 0;
    let drawActive = false;
    let moveHeld = false;

    const setBlock = (ms) => { blockUntil = Math.max(blockUntil, now() + ms); };
    const isBlocked = () => now() < blockUntil;

    map.on("movestart zoomstart", () => setBlock(PATCH.blockAfterZoomMs));
    map.on("moveend zoomend", () => setBlock(250));

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
      if (moved) setBlock(350);
      moved = false;
    }, { passive: true });

    // draw módban, ha mozgatás/zoom volt vagy move-held aktív, nyeljük el a clicket
    container.addEventListener("click", (e) => {
      if (!drawActive) return;
      if (!isBlocked() && !moveHeld) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }, true);

    // ===== 2) Map lock/unlock DRAW módban (hogy mozgatás közben ne lehessen rajzolni)
    function lockMap(lock) {
      try {
        if (lock) {
          map.dragging?.disable();
          map.touchZoom?.disable();
          map.doubleClickZoom?.disable();
          map.scrollWheelZoom?.disable();
          map.boxZoom?.disable();
          map.keyboard?.disable();
        } else {
          map.dragging?.enable();
          map.touchZoom?.enable();
          map.doubleClickZoom?.enable();
          map.scrollWheelZoom?.enable();
          map.boxZoom?.enable();
          map.keyboard?.enable();
        }
      } catch {}
    }

    // ===== 3) Saját polyline draw handler (a popupot az app.js úgyis draw:created-re nyitja)
    let drawHandler = null;
    function ensureDrawHandler() {
      if (drawHandler) return drawHandler;
      if (!window.L || !L.Draw || !L.Draw.Polyline) return null;

      drawHandler = new L.Draw.Polyline(map, {
        shapeOptions: { weight: 4 }
      });
      return drawHandler;
    }

    function setDraw(on) {
      const h = ensureDrawHandler();
      if (!h) return;

      if (on) {
        patchLeafletDrawFinishGate();
        h.enable();
        drawActive = true;
        document.body.classList.add("hh-draw-active");
        quickDrawBtn?.classList.add("hh-active");
        lockMap(true); // draw közben alapból LOCK (ez a kulcs)
      } else {
        h.disable();
        drawActive = false;
        moveHeld = false;
        document.body.classList.remove("hh-draw-active");
        quickDrawBtn?.classList.remove("hh-active");
        lockMap(false);
      }
    }

    function finishDraw() {
      const h = ensureDrawHandler();
      if (!h || !h.enabled || !h.enabled()) return;

      // csak itt engedjük meg a finish-t -> draw:created -> popup
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
      setDraw(false);
    }

    // ha létrejött a vonal, visszaállítjuk az állapotot (a popupot az app.js kezeli)
    map.on("draw:created", () => {
      // draw handler többé nem aktív
      drawActive = false;
      moveHeld = false;
      document.body.classList.remove("hh-draw-active");
      quickDrawBtn?.classList.remove("hh-active");
      lockMap(false);
    });

    // ===== 4) Mobil DRAW sáv: Finish / Undo / Mozgatás(hold) / Mégse
    const bar = document.createElement("div");
    bar.className = "hh-drawbar";
    bar.innerHTML = `
      <button type="button" data-act="finish">Befejezés</button>
      <button type="button" data-act="undo">Utolsó pont</button>
      <button type="button" data-act="move">Mozgatás (tartsd)</button>
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

    // “Mozgatás (tartsd)” = ideiglenes UNLOCK, közben nincs pontozás
    const moveBtn = bar.querySelector('button[data-act="move"]');

    function startMoveHold() {
      if (!drawActive) return;
      moveHeld = true;
      lockMap(false);
      setBlock(1500);
      moveBtn?.classList.add("hh-active");
    }
    function endMoveHold() {
      if (!drawActive) return;
      moveHeld = false;
      lockMap(true);
      setBlock(300);
      moveBtn?.classList.remove("hh-active");
    }

    // pointer (jobb: egyesíti touch+mouse)
    moveBtn?.addEventListener("pointerdown", (e) => { e.preventDefault(); startMoveHold(); });
    moveBtn?.addEventListener("pointerup", (e) => { e.preventDefault(); endMoveHold(); });
    moveBtn?.addEventListener("pointercancel", endMoveHold);
    moveBtn?.addEventListener("pointerleave", endMoveHold);

    // ===== 5) Gyorsgombok: Draw / Refresh / Upload(badge) / Summary / Home
    let quickDrawBtn = null;
    let quickUploadBadge = null;

    const Quick = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        const div = L.DomUtil.create("div", "leaflet-control hh-quick leaflet-bar");
        div.innerHTML = `
          <a href="#" title="Rajzolás" data-act="draw">✍️</a>
          <a href="#" title="Frissítés" data-act="refresh">⟳</a>
          <a href="#" title="Feltöltés" data-act="upload">⬆<span class="hh-badge">0</span></a>
          <a href="#" title="Összesítés" data-act="summary">Σ</a>
          <a href="#" title="Főmenü" data-act="home">⌂</a>
        `;
        L.DomEvent.disableClickPropagation(div);

        quickDrawBtn = div.querySelector('a[data-act="draw"]');
        const uploadA = div.querySelector('a[data-act="upload"]');
        quickUploadBadge = uploadA ? uploadA.querySelector(".hh-badge") : null;

        div.addEventListener("click", (e) => {
          const a = e.target.closest("a[data-act]");
          if (!a) return;
          e.preventDefault();
          const act = a.dataset.act;

          if (act === "draw") setDraw(!drawActive);

          if (act === "refresh") {
            if (typeof window.loadAllRoutes === "function") window.loadAllRoutes();
            else safeClickByText(["Frissítés", "Frissites"]);
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
            // vissza a főmenübe (menüből is ezt csinálja)
            safeClickByText(["Vissza a főmenübe", "Főmenü", "Main menu"]);
          }
        });

        return div;
      },
    });

    map.addControl(new Quick());

    function refreshBadge() {
      if (!quickUploadBadge) return;
      const n = guessOfflineQueueCount();
      quickUploadBadge.textContent = String(n);
      quickUploadBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    refreshBadge();
    setInterval(refreshBadge, 1500);
    window.addEventListener("storage", refreshBadge);

    // ===== 6) “Menü” gomb elrejtése (ha kérted)
    function hideMenuButton() {
      if (!PATCH.hideMenuButton) return;
      const els = Array.from(document.querySelectorAll("button,a"))
        .filter(el => (el.textContent || "").trim().toLowerCase() === "menü" || (el.textContent || "").trim().toLowerCase() === "menu");
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
