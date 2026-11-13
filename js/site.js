(() => {
  "use strict";

  const root = document.documentElement;
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
  const clamp = (v, min = 0, max = 1) => Math.min(max, Math.max(min, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => t * t * (3 - 2 * t);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  // Queries mirror the inline script in index.html.
  const mqReduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const mqHero = window.matchMedia("(min-height: 560px)");
  const mqShowcase = window.matchMedia("(min-width: 960px) and (min-height: 700px)");
  const mode = { motion: false, hero: false, showcase: false };

  const header = $(".site-header");
  const clearStyles = (el, props) => props.forEach((p) => el.style.removeProperty(p));

  // Document offset that ignores transforms (getBoundingClientRect would include them).
  const docTop = (el) => {
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop;
    return y;
  };

  /* ---------- Hero: copy fades out while the demo expands ---------- */

  const hero = $(".hero");
  const heroCopy = $(".hero-copy");
  const frame = $(".media-frame");
  const caption = $(".media-caption");
  const video = $("#demo-video");
  const RATIO = Number(video.getAttribute("width")) / Number(video.getAttribute("height"));
  const H = { top: 0, dist: 1, y0: 0, y1: 0, s0: 1 };
  const HERO_DEMO_AT = 0.8; // progress at which the demo is fully expanded

  function measureHero() {
    if (!mode.hero) return;
    const vw = root.clientWidth;
    const vh = window.innerHeight;
    const headerH = header.offsetHeight;
    const gutter = vw < 700 ? 16 : 40;
    const gap = 16;

    let w = Math.min(vw - gutter * 2, 1240);
    caption.style.width = `${w}px`;
    w = Math.max(240, Math.min(w, (vh - headerH - caption.offsetHeight - gap - 40) * RATIO));
    caption.style.width = `${w}px`;
    frame.style.width = `${w}px`;

    const h = w / RATIO;
    const captionH = caption.offsetHeight;
    H.y1 = headerH + Math.max(12, (vh - headerH - captionH - gap - h) / 2);
    H.y0 = Math.max(heroCopy.offsetHeight + 44, H.y1);
    H.s0 = clamp(780 / w, 0.5, 0.9);
    H.top = docTop(hero);
    H.dist = Math.max(1, hero.offsetHeight - vh);
    caption.style.top = `${H.y1 + h + gap}px`;
  }

  function renderHero(y) {
    const p = clamp((y - H.top) / H.dist);
    const out = clamp(p / 0.26);
    const grow = smooth(clamp(p / 0.72));
    const cap = easeOut(clamp((p - 0.56) / 0.18));

    heroCopy.style.opacity = 1 - out;
    heroCopy.style.transform = `translate3d(0, ${-out * 70}px, 0) scale(${1 - out * 0.05})`;
    heroCopy.style.visibility = out >= 1 ? "hidden" : "visible";
    frame.style.transform = `translate3d(-50%, ${lerp(H.y0, H.y1, grow)}px, 0) scale(${lerp(H.s0, 1, grow)})`;
    caption.style.opacity = cap;
    caption.style.transform = `translate3d(-50%, ${(1 - cap) * 18}px, 0)`;
  }

  function resetHero() {
    clearStyles(heroCopy, ["opacity", "transform", "visibility"]);
    clearStyles(frame, ["width", "transform"]);
    clearStyles(caption, ["width", "top", "opacity", "transform"]);
  }

  /* ---------- Interface: pinned stage, tabs driven by scroll ---------- */

  const track = $(".showcase-track");
  const tabs = $$(".tab");
  const indicator = $(".tabs-indicator");
  const steps = $$(".step").map((el) => ({ el, shot: $(".shot", el), copy: $(".step-copy", el) }));
  const LAST = steps.length - 1;
  const HOLD = 0.3; // rest (in steps) before the first and after the last transition
  const SPAN = LAST + HOLD * 2;
  const S = { top: 0, dist: 1, tabs: [] };
  let activeStep = -1;

  function measureShowcase() {
    if (!mode.showcase) return;
    S.top = docTop(track);
    S.dist = Math.max(1, track.offsetHeight - window.innerHeight);
    S.tabs = tabs.map((t) => [t.offsetLeft, t.offsetWidth]);
  }

  const stepScrollY = (i) => S.top + (S.dist * (i + HOLD)) / SPAN;

  function renderShowcase(y) {
    const p = clamp((y - S.top) / S.dist);
    const f = clamp(p * SPAN - HOLD, 0, LAST);
    const base = Math.min(LAST - 1, Math.floor(f));
    // Each step rests, then hands over to the next one.
    const pos = base + smooth(clamp((f - base - 0.3) / 0.4));

    steps.forEach(({ el, shot, copy }, i) => {
      const t = pos - i;
      const a = Math.abs(t);
      el.style.visibility = a < 0.999 ? "visible" : "hidden";
      el.style.pointerEvents = a < 0.5 ? "auto" : "none";
      el.style.zIndex = i + 1;
      // The incoming screenshot fades in on top of the previous one, so the window never dims.
      shot.style.opacity = t >= 0 ? 1 : 1 - clamp((a - 0.1) / 0.8);
      copy.style.opacity = 1 - clamp(a / 0.5);
      copy.style.transform = `translate3d(0, ${-t * 64}px, 0)`;
    });

    if (S.tabs.length) {
      const k = pos - base;
      const [x0, w0] = S.tabs[base];
      const [x1, w1] = S.tabs[base + 1];
      indicator.style.transform = `translate3d(${lerp(x0, x1, k)}px, 0, 0)`;
      indicator.style.width = `${lerp(w0, w1, k)}px`;
    }

    const active = Math.round(pos);
    if (active !== activeStep) {
      activeStep = active;
      tabs.forEach((tab, i) => {
        if (i === active) tab.setAttribute("aria-current", "true");
        else tab.removeAttribute("aria-current");
      });
    }
  }

  function resetShowcase() {
    activeStep = -1;
    steps.forEach(({ el, shot, copy }) => {
      clearStyles(el, ["visibility", "pointer-events", "z-index"]);
      clearStyles(shot, ["opacity"]);
      clearStyles(copy, ["opacity", "transform"]);
    });
  }

  tabs.forEach((tab, i) =>
    tab.addEventListener("click", () => window.scrollTo({ top: stepScrollY(i), behavior: "smooth" })),
  );

  /* ---------- Small scroll-linked accents ---------- */

  const scrubs = $$("[data-scrub]").map((el) => ({ el, top: 0 }));
  const parallax = $$("[data-parallax]").map((el) => ({ el, mid: 0, amount: Number(el.dataset.parallax) || 20 }));

  function measureAccents() {
    scrubs.forEach((o) => (o.top = docTop(o.el)));
    parallax.forEach((o) => (o.mid = docTop(o.el) + o.el.offsetHeight / 2));
  }

  function renderAccents(y) {
    const vh = window.innerHeight;
    scrubs.forEach(({ el, top }) => {
      const q = easeOut(clamp((y + vh - top) / (vh * 0.75)));
      el.style.transform = `scale(${lerp(0.84, 1, q)})`;
      el.style.opacity = lerp(0.1, 1, q);
    });
    parallax.forEach(({ el, mid, amount }) => {
      const d = (mid - (y + vh / 2)) / vh;
      if (Math.abs(d) < 1.2) el.style.transform = `translate3d(0, ${clamp(d, -1, 1) * amount}px, 0)`;
    });
  }

  function resetAccents() {
    scrubs.forEach(({ el }) => clearStyles(el, ["transform", "opacity"]));
    parallax.forEach(({ el }) => clearStyles(el, ["transform"]));
  }

  /* ---------- Scroll loop: animations follow an eased scroll position ---------- */

  let easedY = window.scrollY;
  let lastTime = 0;
  let queued = false;

  function requestTick() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tick);
  }

  function tick(now) {
    queued = false;
    const target = window.scrollY;
    const diff = target - easedY;
    if (!mode.motion || Math.abs(diff) < 0.3) {
      easedY = target;
      lastTime = 0;
    } else {
      const dt = lastTime ? Math.min(50, now - lastTime) : 16.7;
      easedY += diff * (1 - Math.exp(-dt / 85));
      lastTime = now;
      requestTick();
    }
    header.classList.toggle("scrolled", target > 8);
    if (mode.hero) renderHero(easedY);
    if (mode.showcase) renderShowcase(easedY);
    if (mode.motion) renderAccents(easedY);
  }

  function measure() {
    measureHero();
    measureShowcase();
    if (mode.motion) measureAccents();
    requestTick();
  }

  function syncMode() {
    mode.motion = !mqReduce.matches;
    mode.hero = mode.motion && mqHero.matches;
    mode.showcase = mode.motion && mqShowcase.matches;
    root.classList.toggle("motion", mode.motion);
    root.classList.toggle("fx-hero", mode.hero);
    root.classList.toggle("fx-showcase", mode.showcase);
    if (!mode.hero) resetHero();
    if (!mode.showcase) resetShowcase();
    if (!mode.motion) resetAccents();
    easedY = window.scrollY;
    measure();
  }

  [mqReduce, mqHero, mqShowcase].forEach((mq) => mq.addEventListener("change", syncMode));
  window.addEventListener("scroll", requestTick, { passive: true });
  window.addEventListener("resize", measure);
  window.addEventListener("load", measure);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measure);
  syncMode();

  /* ---------- Anchors that point into pinned sections ---------- */

  const demoScrollY = () => H.top + H.dist * HERO_DEMO_AT;

  $$('a[href="#demo"]').forEach((link) =>
    link.addEventListener("click", (event) => {
      if (!mode.hero) return;
      event.preventDefault();
      window.scrollTo({ top: demoScrollY(), behavior: "smooth" });
    }),
  );
  if (mode.hero && window.location.hash === "#demo") {
    window.addEventListener("load", () => window.scrollTo({ top: demoScrollY(), behavior: "instant" }));
  }

  /* ---------- Reveal on scroll ---------- */

  const reveals = $$("[data-reveal]");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }),
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  /* ---------- Mobile menu ---------- */

  const menuToggle = $(".menu-toggle");
  const nav = $(".main-nav");

  function setMenu(open) {
    header.classList.toggle("nav-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
    menuToggle.setAttribute("aria-label", open ? "Закрыть меню" : "Открыть меню");
  }

  menuToggle.addEventListener("click", () => setMenu(!header.classList.contains("nav-open")));
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setMenu(false);
  });
  document.addEventListener("click", (event) => {
    if (!header.contains(event.target)) setMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && header.classList.contains("nav-open")) {
      setMenu(false);
      menuToggle.focus();
    }
  });

  /* ---------- Demo video: plays only while visible, can be paused ---------- */

  const videoToggle = $(".media-toggle");
  let videoVisible = false;
  let videoPausedByUser = mqReduce.matches;

  function syncVideo() {
    if (videoVisible && !videoPausedByUser && !document.hidden) {
      const playing = video.play();
      if (playing) playing.catch(() => {});
    } else {
      video.pause();
    }
  }

  function syncVideoToggle() {
    videoToggle.classList.toggle("is-paused", video.paused);
    videoToggle.setAttribute("aria-label", video.paused ? "Воспроизвести демонстрацию" : "Приостановить демонстрацию");
  }

  video.controls = false;
  videoToggle.hidden = false;
  videoToggle.addEventListener("click", () => {
    videoPausedByUser = !video.paused;
    syncVideo();
  });
  video.addEventListener("play", syncVideoToggle);
  video.addEventListener("pause", syncVideoToggle);
  document.addEventListener("visibilitychange", syncVideo);
  syncVideoToggle();

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        videoVisible = entry.isIntersecting;
        syncVideo();
      },
      { threshold: 0.2 },
    ).observe(frame);
  } else {
    videoVisible = true;
    syncVideo();
  }

  /* ---------- Screenshot lightbox ---------- */

  const dialog = $("#lightbox");
  if (dialog && typeof dialog.showModal === "function") {
    const image = $("#lightbox-image", dialog);
    const stage = $(".lightbox-stage", dialog);
    const label = $("#lightbox-caption", dialog);
    const zoomToggle = $(".zoom-toggle", dialog);
    let current = 0;

    const setZoom = (on) => {
      stage.classList.toggle("zoomed", on);
      zoomToggle.setAttribute("aria-pressed", String(on));
    };

    const show = (i) => {
      current = (i + steps.length) % steps.length;
      const { el, shot } = steps[current];
      image.src = shot.getAttribute("href");
      image.alt = $("img", shot).alt;
      label.textContent = `${el.dataset.name} · ${current + 1} / ${steps.length}`;
    };

    steps.forEach(({ shot }, i) =>
      shot.addEventListener("click", (event) => {
        event.preventDefault();
        show(i);
        setZoom(false);
        dialog.showModal();
        root.classList.add("dialog-open");
        // Offer 100% zoom only when the screenshot does not fit at its real size.
        const fullWidth = Number(image.getAttribute("width")) + 2 * parseFloat(getComputedStyle(stage).paddingLeft);
        zoomToggle.hidden = stage.clientWidth >= fullWidth;
      }),
    );

    $("[data-prev]", dialog).addEventListener("click", () => show(current - 1));
    $("[data-next]", dialog).addEventListener("click", () => show(current + 1));
    $("[data-close]", dialog).addEventListener("click", () => dialog.close());
    zoomToggle.addEventListener("click", () => setZoom(!stage.classList.contains("zoomed")));
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target === stage) dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(current - 1);
      if (event.key === "ArrowRight") show(current + 1);
    });
    dialog.addEventListener("close", () => root.classList.remove("dialog-open"));
  }
})();
