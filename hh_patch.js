/* ===== HangHordó: mobilbarát rajzolás + térképes gyorsgombok ===== */
(function () {
  const PATCH = {
    movePxThreshold: 10,
    blockAfterMoveMs: 700,
    blockAfterZoomMs: 900,
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
    // próbáljuk megtalálni az “offline queue” tömböt a localStorage-ben
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
      try {
        const j = JSON.parse(v);
        if (Array.isArray(j)) return j.length;
      } catch {}
    }

    // fallback: végignézzük a kulcsokat
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (!/queue|pending|offline/i.test(k)) continue;
      const v = localStorage.getItem(k);
      if (!v) continue;
      try {
        const j = JSON.parse(v);
        if (Array.isArray(j)) return j.length;
      } catch {}
    }
    return 0;
  }

  function installForMap(map) {
    if (map.__hhPatched) return;
    map.__hhPatched = true;

    // ===== 1) Gesztus-blokkolás: mozgatás/zoom/pinch után ne legyen “véletlen pont” =====
    const container = map.getContainer();
    let blockUntil = 0;
    let drawActive = false;

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

    // click CAPTURE: draw módban, ha blokkolt, elnyeljük a kattot (így nem rak le pontot)
    container.addEventListener("click", (e) => {
      if (!drawActive) return;
      if (!isBlocked()) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    }, true);

    // ===== 2) Saját rajzoló handler (Leaflet.Draw) + nagy mobil gombok =====
    let drawHandler = null;

    function ensureDrawHandler() {
      if (drawHandler) return drawHandler;
      if (!window.L || !L.Draw || !L.Draw.Polyline) return null;

      drawHandler = new L.Draw.Polyline(map, {
        // szándékosan minimál: a te appod úgyis kezeli a draw:created eseményt
        shapeOptions: { weight: 4 }
      });
      return drawHandler;
    }

    function setDraw(on) {
      const h = ensureDrawHandler();
      if (!h) return;

      if (on) {
        h.enable();
        drawActive = true;
        document.body.classList.add("hh-draw-active");
        quickDrawBtn?.classList.add("hh-active");
      } else {
        h.disable();
        drawActive = false;
        document.body.classList.remove("hh-draw-active");
        quickDrawBtn?.classList.remove("hh-active");
      }
    }

    function finishDraw() {
      const h = ensureDrawHandler();
      if (!h) return;
      if (!h.enabled || !h.enabled()) return;

      if (typeof h.completeShape === "function") h.completeShape();
      else if (typeof h._finishShape === "function") h._finishShape();
      // draw:created eventet a Leaflet.Draw fogja leadni
    }

    function undoLast() {
      const h = ensureDrawHandler();
      if (!h) return;
      if (!h.enabled || !h.enabled()) return;

      if (typeof h.deleteLastVertex === "function") h.deleteLastVertex();
    }

    function cancelDraw() {
      setDraw(false);
    }

    // mobil bottom bar
    const bar = document.createElement("div");
    bar.className = "hh-drawbar";
    bar.innerHTML = `
      <button type="button" data-act="finish">Befejezés</button>
      <button type="button" data-act="undo">Utolsó pont</button>
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

    // ===== 3) Térképes gyorsgombok (Frissítés / Feltöltés / Összesítés + Draw) =====
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
            // ha van globál függvény, használd, különben próbáljuk “szöveg alapján kattintani”
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
        });

        return div;
      },
    });

    map.addControl(new Quick());

    // badge frissítés
    function refreshBadge() {
      if (!quickUploadBadge) return;
      const n = guessOfflineQueueCount();
      quickUploadBadge.textContent = String(n);
      quickUploadBadge.style.display = n > 0 ? "inline-block" : "none";
    }
    refreshBadge();
    setInterval(refreshBadge, 1500);
    window.addEventListener("storage", refreshBadge);

    // amikor a draw leáll (pl. kész lett), vegyük le az aktív állapotot
    map.on("draw:drawstop", () => {
      drawActive = false;
      document.body.classList.remove("hh-draw-active");
      quickDrawBtn?.classList.remove("hh-active");
    });
  }

  function bootstrap() {
    if (!window.L || !L.Map || !L.Map.addInitHook) {
      // Leaflet még nincs betöltve
      setTimeout(bootstrap, 50);
      return;
    }

    // garantáljuk, hogy a map init után mindig fut a patch
    L.Map.addInitHook(function () {
      try { installForMap(this); } catch (e) { console.error("HH patch error:", e); }
    });
  }

  bootstrap();
})();
