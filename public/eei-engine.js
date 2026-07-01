import * as THREE from "./vendor/three.module.js";

const EEI_VERSION = "0.22.0";
const MAX_Z_INDEX = "2147483647";
const DEFAULT_TIMEZONE = "America/Mexico_City";

export const DEFAULT_CONFIG = {
  version: 22,
  enabled: true,
  assetsBaseUrl: "auto",
  performance: {
    maxPixelRatio: 1.5,
    pauseWhenHidden: true
  },
  injection: {
    excludeHostnamesExact: []
  },
  campaigns: {
    isv: {
      enabled: true,
      scriptUrl: "https://isv-ev2.pages.dev/isv-banner.js",
      includeHostnames: [],
      excludeHostnames: []
    }
  },
  maintenance: {
    enabled: false,
    title: "Mantenimiento programado",
    message: "La plataforma entrará en una ventana breve de servicio.",
    targetAt: "2026-07-01T03:00:00-06:00",
    severity: "planned"
  },
  birthday: {
    enabled: true,
    mode: "api",
    apiUrl: "/__eei/signia-birthdays",
    plantelesApiUrl: "/__eei/signia-planteles",
    timezone: DEFAULT_TIMEZONE,
    showOncePerDay: true,
    toastDurationMs: 9500,
    subscriptionPrompt: true,
    mockBirthdays: []
  },
  festivities: {
    christmas: {
      enabled: false,
      intensity: 0.82,
      wind: 0.55
    },
    new_year: {
      enabled: false,
      intensity: 0.75,
      durationMs: 14000
    },
    mundial_2026: {
      enabled: false,
      intensity: 0.42,
      sportsApiUrl: "/__eei/worldcup-matches",
      priorityTeam: "Mexico",
      compactPin: true,
      hidePinPerDay: true,
      ballCount: 4,
      ballLifetimeMs: 18000,
      ballAutoExitAfterMs: 10500,
      ballInteraction: true,
      ballDrag: true
    }
  },
  assets: {
    ambassadors: {
      birthday: "ambassadors/birthday-ambassador.png",
      birthdayAlternate: "ambassadors/birthday-joy-ambassador.png",
      sports: "ambassadors/sports-ambassador.png",
      winter: "ambassadors/winter-ambassador.png",
      maintenance: "ambassadors/maintenance-ambassador.png",
      newYear: "ambassadors/new-year-ambassador.png"
    },
    textures: {
      trionda: "textures/trionda-equirectangular.png",
      balloons: "textures/balloon-atlas.png",
      particles: "textures/particle-atlas.png"
    }
  }
};

let activeInstance = null;

export async function startEEI(config = {}, options = {}) {
  if (activeInstance) {
    await activeInstance.updateConfig(config, options);
    return activeInstance;
  }

  activeInstance = new EEIOverlay(config, options);
  await activeInstance.mount();
  return activeInstance;
}

export async function updateEEI(config = {}, options = {}) {
  return startEEI(config, options);
}

export function destroyEEI() {
  if (activeInstance) {
    activeInstance.destroy();
    activeInstance = null;
  }
}

export function getEEI() {
  return activeInstance;
}

class EEIOverlay {
  constructor(config = {}, options = {}) {
    this.config = normalizeConfig(config);
    this.options = {
      sandbox: false,
      configEndpoint: "",
      ...options
    };

    this.host = null;
    this.shadow = null;
    this.uiLayer = null;
    this.canvasMount = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.clock = new THREE.Clock(false);
    this.rafId = 0;
    this.paused = false;
    this.destroyed = false;
    this.abort = new AbortController();
    this.restoreHistory = [];
    this.routeRefreshTimer = 0;
    this.lastFrameAt = 0;

    this.textureRegistry = null;
    this.transientTextures = new Set();
    this.size = { width: 1, height: 1 };

    this.modules = {
      maintenance: new MaintenanceModule(this),
      birthdays: new BirthdayModule(this),
      snow: new SnowModule(this),
      fireworks: new FireworksModule(this),
      mundial: new MundialModule(this)
    };
  }

  async mount() {
    if (!document.body) {
      await waitForBody();
    }

    this.createDom();
    this.createRenderer();
    this.createScene();
    this.installListeners();
    await this.updateConfig(this.config, { replace: true, initial: true });
    this.startLoop();
  }

  createDom() {
    const previous = document.getElementById("eei-overlay-root");
    if (previous) {
      previous.remove();
    }

    this.host = document.createElement("div");
    this.host.id = "eei-overlay-root";
    this.host.setAttribute("data-eei-version", EEI_VERSION);
    Object.assign(this.host.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: MAX_Z_INDEX,
      overflow: "hidden",
      contain: "layout style paint",
      display: "block"
    });

    this.shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = overlayCss();
    this.canvasMount = document.createElement("div");
    this.canvasMount.className = "eei-canvas-mount";
    this.uiLayer = document.createElement("div");
    this.uiLayer.className = "eei-ui-layer";

    this.shadow.append(style, this.canvasMount, this.uiLayer);
    document.body.appendChild(this.host);
  }

  createRenderer() {
    this.textureRegistry?.dispose();
    this.textureRegistry = new TextureRegistry();

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      depth: true,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance"
    });

    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.sortObjects = true;

    const canvas = this.renderer.domElement;
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      display: "block",
      pointerEvents: "none",
      zIndex: MAX_Z_INDEX
    });

    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.pause();
    }, { signal: this.abort.signal });

    canvas.addEventListener("webglcontextrestored", () => {
      this.recoverRenderer();
    }, { signal: this.abort.signal });

    this.canvasMount.replaceChildren(canvas);
    this.resize();
  }

  createScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, -2000, 2000);
    this.camera.position.set(0, 0, 1000);

    const ambient = new THREE.AmbientLight(0xffffff, 1.45);
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(300, 500, 800);
    this.scene.add(ambient, key);
  }

  installListeners() {
    window.addEventListener("resize", () => this.resize(), {
      passive: true,
      signal: this.abort.signal
    });

    document.addEventListener("visibilitychange", () => {
      if (!this.config.performance?.pauseWhenHidden) {
        return;
      }

      if (document.hidden) {
        this.pause();
      } else {
        this.resume();
      }
    }, { signal: this.abort.signal });

    window.addEventListener("pagehide", () => this.destroy(), {
      once: true,
      signal: this.abort.signal
    });

    this.installSpaHooks();
  }

  installSpaHooks() {
    if (!window.history) {
      return;
    }

    const notify = () => {
      window.clearTimeout(this.routeRefreshTimer);
      this.routeRefreshTimer = window.setTimeout(() => this.handleRouteChange(), 80);
    };

    for (const method of ["pushState", "replaceState"]) {
      const original = window.history[method];
      const wrapper = function eeiHistoryWrapper(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
      window.history[method] = wrapper;
      this.restoreHistory.push(() => {
        if (window.history[method] === wrapper) {
          window.history[method] = original;
        }
      });
    }

    window.addEventListener("popstate", notify, {
      passive: true,
      signal: this.abort.signal
    });
  }

  async handleRouteChange() {
    if (this.destroyed || this.options.sandbox) {
      return;
    }

    const endpoint = this.options.configEndpoint || window.__EEI_BOOT__?.configEndpoint;
    if (!endpoint) {
      return;
    }

    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (response.ok) {
        await this.updateConfig(await response.json(), { routeChange: true, replace: true });
      }
    } catch {
      // Route changes must never break host navigation.
    }
  }

  resize() {
    if (!this.renderer || !this.camera) {
      return;
    }

    const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    this.size.width = width;
    this.size.height = height;

    const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, Number(this.config.performance?.maxPixelRatio || 1.5)));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);

    this.camera.left = -width / 2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = -height / 2;
    this.camera.updateProjectionMatrix();
  }

  async updateConfig(config = {}, options = {}) {
    if (this.destroyed) {
      return;
    }

    this.config = normalizeConfig(options.replace ? config : deepMerge(this.config, config));
    this.host.style.display = this.config.enabled ? "block" : "none";
    this.resize();

    if (!this.config.enabled) {
      this.stopAllModules();
      return;
    }

    this.modules.maintenance.setEnabled(Boolean(this.config.maintenance?.enabled), this.config.maintenance);

    const birthdayEnabled = Boolean(this.config.birthday?.enabled);
    if (!birthdayEnabled) {
      this.modules.birthdays.stop();
    } else if (!this.modules.birthdays.active || options.forceBirthday) {
      if (options.forceBirthday) {
        this.modules.birthdays.stop();
      }
      this.modules.birthdays.start(this.config.birthday, options);
    }

    this.modules.snow.setEnabled(Boolean(this.config.festivities?.christmas?.enabled), this.config.festivities?.christmas || {});
    this.modules.fireworks.setEnabled(Boolean(this.config.festivities?.new_year?.enabled), this.config.festivities?.new_year || {});
    this.modules.mundial.setEnabled(Boolean(this.config.festivities?.mundial_2026?.enabled), this.config.festivities?.mundial_2026 || {});
  }

  startLoop() {
    if (this.rafId || this.destroyed) {
      return;
    }

    this.clock.start();
    const tick = (time) => {
      this.rafId = window.requestAnimationFrame(tick);
      if (this.paused || this.destroyed || !this.renderer || !this.scene || !this.camera) {
        return;
      }

      const dt = Math.min(0.04, Math.max(0.001, this.clock.getDelta()));
      const elapsed = time / 1000;

      for (const module of Object.values(this.modules)) {
        module.update?.(dt, elapsed);
      }

      this.renderer.render(this.scene, this.camera);
      this.lastFrameAt = time;
    };

    this.rafId = window.requestAnimationFrame(tick);
  }

  pause() {
    this.paused = true;
    this.clock.stop();
  }

  resume() {
    if (this.destroyed) {
      return;
    }

    this.paused = false;
    this.clock.start();
  }

  recoverRenderer() {
    if (this.destroyed) {
      return;
    }

    const config = clone(this.config);
    this.stopVisualModules();
    this.disposeTransientTextures();
    this.textureRegistry?.dispose();
    this.createRenderer();
    this.createScene();
    this.updateConfig(config, { replace: true, rebuild: true });
    this.resume();
  }

  stopAllModules() {
    for (const module of Object.values(this.modules)) {
      module.stop?.();
    }
  }

  stopVisualModules() {
    this.modules.birthdays.stop();
    this.modules.snow.stop();
    this.modules.fireworks.stop();
    this.modules.mundial.stop();
  }

  assetUrl(kind, key) {
    const configured = this.config.assets?.[kind]?.[key];
    if (!configured) {
      return "";
    }

    if (/^(https?:|data:|blob:|\/)/i.test(configured)) {
      return configured;
    }

    const base = this.config.assetsBaseUrl && this.config.assetsBaseUrl !== "auto"
      ? this.config.assetsBaseUrl
      : new URL("./assets/", import.meta.url).toString();

    return `${base.replace(/\/$/, "")}/${configured.replace(/^\//, "")}`;
  }

  getTexture(key, url, options = {}) {
    return this.textureRegistry.get(key, url, options);
  }

  getParticleAtlasTile(index) {
    const texture = createParticleCanvasTexture(index);
    this.transientTextures.add(texture);
    return texture;
  }

  releaseTransientTexture(texture) {
    if (texture && this.transientTextures.has(texture)) {
      texture.dispose();
      this.transientTextures.delete(texture);
    }
  }

  disposeTransientTextures() {
    for (const texture of this.transientTextures) {
      texture.dispose();
    }
    this.transientTextures.clear();
  }

  showToast(id, data) {
    const existing = this.uiLayer.querySelector(`[data-toast-id="${cssEscape(id)}"]`);
    existing?.remove();

    const toast = document.createElement("section");
    toast.className = "eei-toast";
    toast.dataset.toastId = id;

    const image = data.image ? `<img src="${escapeAttribute(data.image)}" alt="" loading="eager">` : "";
    const people = (data.people || []).slice(0, 3).map((person) => {
      const detail = [person.puesto, person.plantel].filter(Boolean).join(" | ");
      return `<li><strong>${escapeHtml(person.name || "Colaborador")}</strong>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</li>`;
    }).join("");

    toast.innerHTML = `
      ${image}
      <div>
        <p class="eei-eyebrow">${escapeHtml(data.eyebrow || "EEI")}</p>
        <h2>${escapeHtml(data.title || "")}</h2>
        ${data.message ? `<p class="eei-toast-message">${escapeHtml(data.message)}</p>` : ""}
        ${people ? `<ul>${people}</ul>` : ""}
      </div>
    `;

    this.uiLayer.appendChild(toast);
    const duration = Number(data.durationMs || 8000);
    window.setTimeout(() => toast.classList.add("is-leaving"), Math.max(800, duration - 360));
    window.setTimeout(() => toast.remove(), duration);
  }

  setWorldCupWidget(config, matches) {
    const today = todayInTimeZone(DEFAULT_TIMEZONE);
    const storageKey = config.hidePinPerDay === false ? "eei-worldcup-hidden" : `eei-worldcup-hidden:${today}`;
    const existing = this.uiLayer.querySelector("[data-eei-widget='worldcup']");

    if (safeLocalStorageGet(storageKey) === "1") {
      existing?.remove();
      return;
    }

    const priorityTeam = (config.priorityTeam || "Mexico").toLowerCase();
    const sorted = [...(matches || [])].sort((a, b) => {
      const aPriority = [a.home, a.away].some((team) => String(team).toLowerCase().includes(priorityTeam)) ? 0 : 1;
      const bPriority = [b.home, b.away].some((team) => String(team).toLowerCase().includes(priorityTeam)) ? 0 : 1;
      return aPriority - bPriority || String(a.time || "").localeCompare(String(b.time || ""));
    }).slice(0, 3);

    if (!sorted.length) {
      existing?.remove();
      return;
    }

    let widget = existing;
    if (!widget) {
      widget = document.createElement("aside");
      widget.className = "eei-worldcup eei-worldcup-pin";
      widget.dataset.eeiWidget = "worldcup";
      this.uiLayer.appendChild(widget);
    }

    const chips = sorted.map((match) => {
      const homeFlag = teamFlag(match.homeTla || match.home || "");
      const awayFlag = teamFlag(match.awayTla || match.away || "");
      const label = `${match.home || "Home"} vs ${match.away || "Away"}${match.time ? `, ${match.time}` : ""}`;
      return `<span class="eei-worldcup-chip" title="${escapeAttribute(label)}" aria-label="${escapeAttribute(label)}"><span>${homeFlag}</span><span>${awayFlag}</span></span>`;
    }).join("");

    widget.innerHTML = `
      <div class="eei-worldcup-flags" aria-label="Partidos del Mundial de hoy">${chips}</div>
      <button class="eei-worldcup-hide" type="button" aria-label="Ocultar Mundial">×</button>
    `;

    const button = widget.querySelector(".eei-worldcup-hide");
    button?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      safeLocalStorageSet(storageKey, "1");
      widget.remove();
    }, { once: true });
  }

  clearWorldCupWidget() {
    this.uiLayer.querySelector("[data-eei-widget='worldcup']")?.remove();
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    window.cancelAnimationFrame(this.rafId);
    window.clearTimeout(this.routeRefreshTimer);
    this.rafId = 0;

    this.stopAllModules();
    this.abort.abort();
    for (const restore of this.restoreHistory) {
      try {
        restore();
      } catch {
        // Nothing to do; the page is leaving or another wrapper owns history now.
      }
    }

    this.disposeTransientTextures();
    this.textureRegistry?.dispose();

    if (this.renderer) {
      this.renderer.dispose();
      try {
        this.renderer.forceContextLoss();
      } catch {
        // Some browsers disallow explicit context loss.
      }
      this.renderer.domElement.remove();
    }

    this.host?.remove();
  }
}

class TextureRegistry {
  constructor() {
    this.loader = new THREE.TextureLoader();
    this.loader.setCrossOrigin("anonymous");
    this.cache = new Map();
  }

  get(key, url, options = {}) {
    if (!url) {
      return null;
    }

    const cacheKey = `${key}:${url}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const texture = this.loader.load(url, () => {
      texture.needsUpdate = true;
    });
    texture.colorSpace = options.colorSpace || THREE.SRGBColorSpace;
    texture.wrapS = options.wrap || THREE.RepeatWrapping;
    texture.wrapT = options.wrap || THREE.RepeatWrapping;
    texture.anisotropy = 4;
    this.cache.set(cacheKey, texture);
    return texture;
  }

  dispose() {
    for (const texture of this.cache.values()) {
      texture.dispose();
    }
    this.cache.clear();
  }
}

class MaintenanceModule {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.element = null;
    this.timer = 0;
    this.config = {};
  }

  setEnabled(enabled, config = {}) {
    if (!enabled) {
      this.stop();
      return;
    }

    this.config = config;
    if (!this.active) {
      this.start();
    }
    this.render();
  }

  start() {
    this.active = true;
    this.element = document.createElement("section");
    this.element.className = "eei-maintenance";
    this.element.dataset.eeiWidget = "maintenance";
    this.engine.uiLayer.appendChild(this.element);
    this.timer = window.setInterval(() => this.render(), 1000);
  }

  render() {
    if (!this.element) {
      return;
    }

    const target = Date.parse(this.config.targetAt || "");
    const remaining = Number.isFinite(target) ? target - Date.now() : 0;
    const countdown = Number.isFinite(target) ? formatCountdown(remaining) : "TBD";
    const done = remaining <= 0 && Number.isFinite(target);
    const ambassador = this.engine.assetUrl("ambassadors", "maintenance");

    this.element.innerHTML = `
      <img src="${escapeAttribute(ambassador)}" alt="">
      <div class="eei-maintenance-copy">
        <p class="eei-eyebrow">${escapeHtml(this.config.severity || "planned")}</p>
        <strong>${escapeHtml(this.config.title || "Mantenimiento")}</strong>
        <span>${escapeHtml(this.config.message || "")}</span>
      </div>
      <div class="eei-countdown" aria-label="Countdown">
        <span>${done ? "Ahora" : escapeHtml(countdown)}</span>
        <small>${done ? "Ventana activa" : "para iniciar"}</small>
      </div>
    `;
  }

  update() {}

  stop() {
    if (!this.active) {
      return;
    }

    this.active = false;
    window.clearInterval(this.timer);
    this.timer = 0;
    this.element?.remove();
    this.element = null;
  }
}

class BirthdayModule {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.group = null;
    this.confetti = null;
    this.balloons = [];
    this.releaseStartedAt = 0;
    this.config = {};
    this.dummy = new THREE.Object3D();
  }

  async start(config = {}, options = {}) {
    this.active = true;
    this.config = config;

    const data = await this.loadBirthdays(options);
    if (!this.active) {
      return;
    }

    const allBirthdays = Array.isArray(data.birthdays) ? data.birthdays.map(normalizeBirthdayRecord) : [];
    const allPlanteles = await this.loadAllPlanteles(data);

    if (allPlanteles.length) {
      writeKnownBirthdayPlanteles(mergePlantelLists(readKnownBirthdayPlanteles(), allPlanteles).slice(0, 120));
    }

    if (allBirthdays.length === 0) {
      return;
    }

    this.rememberKnownPlanteles(allBirthdays);
    const plantelesForPreferences = mergePlantelLists(allPlanteles, readKnownBirthdayPlanteles(), listUniquePlanteles(allBirthdays)).slice(0, 120);
    const birthdays = this.filterBySubscribedPlanteles(allBirthdays);
    this.showPlantelSubscriptionPrompt(plantelesForPreferences, config);

    if (birthdays.length === 0) {
      return;
    }

    const date = data.date || todayInTimeZone(config.timezone || DEFAULT_TIMEZONE);
    if (!options.forceBirthday && config.showOncePerDay && this.hasShown(date)) {
      return;
    }

    this.markShown(date);
    this.release(birthdays);
    this.announceBirthdays(birthdays, config);
  }

  announceBirthdays(birthdays, config = {}) {
    const people = Array.isArray(birthdays) ? birthdays.slice(0, 12) : [];
    const duration = Math.max(4200, Number(config.toastDurationMs || 6500));
    const gap = Math.min(5200, Math.max(2600, duration - 1400));
    people.forEach((person, index) => {
      window.setTimeout(() => {
        if (!this.active) {
          return;
        }
        const name = person.displayName || person.name || "Colaborador";
        const plantelName = getBirthdayPlantel(person)?.name || person.plantelName || person.plantel || "";
        const detail = [person.puesto, plantelName].filter(Boolean).join(" · ");
        this.engine.showToast(`birthday-${cssEscape(String(person.id || index))}`, {
          eyebrow: "Cumpleaños de hoy",
          title: `Hoy celebramos a ${name}`,
          message: detail || "Gracias por ser parte de la comunidad.",
          people: [],
          image: this.engine.assetUrl("ambassadors", index % 2 ? "birthdayAlternate" : "birthday"),
          durationMs: duration
        });
      }, index * gap);
    });
  }

  async loadBirthdays(options = {}) {
    const empty = {
      date: todayInTimeZone(this.config.timezone || DEFAULT_TIMEZONE),
      timezone: this.config.timezone || DEFAULT_TIMEZONE,
      count: 0,
      birthdays: []
    };

    if (this.config.mode === "mock") {
      return {
        ...empty,
        count: this.config.mockBirthdays?.length || 0,
        birthdays: this.config.mockBirthdays || []
      };
    }

    try {
      const response = await fetch(this.config.apiUrl || DEFAULT_CONFIG.birthday.apiUrl, {
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json"
        }
      });
      if (!response.ok) {
        return empty;
      }
      const payload = await response.json();
      return {
        ...empty,
        ...payload,
        birthdays: Array.isArray(payload.birthdays) ? payload.birthdays : []
      };
    } catch {
      return empty;
    }
  }

  async loadAllPlanteles(data = {}) {
    const fromBirthdayPayload = Array.isArray(data.planteles) ? data.planteles : [];
    const known = readKnownBirthdayPlanteles();

    if (this.config.mode === "mock") {
      return mergePlantelLists(fromBirthdayPayload, known);
    }

    const apiUrl = this.config.plantelesApiUrl || DEFAULT_CONFIG.birthday.plantelesApiUrl;
    if (!apiUrl) {
      return mergePlantelLists(fromBirthdayPayload, known);
    }

    try {
      const response = await fetch(apiUrl, {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) {
        return mergePlantelLists(fromBirthdayPayload, known);
      }
      const payload = await response.json();
      const source = Array.isArray(payload) ? payload : Array.isArray(payload?.planteles) ? payload.planteles : [];
      return mergePlantelLists(source, fromBirthdayPayload, known);
    } catch {
      return mergePlantelLists(fromBirthdayPayload, known);
    }
  }

  filterBySubscribedPlanteles(birthdays) {
    const preference = readBirthdayPlantelPreference();
    if (preference.mode !== "custom") {
      return birthdays;
    }

    const selected = new Set(Array.isArray(preference.selected) ? preference.selected : []);
    if (selected.size === 0) {
      return [];
    }

    return birthdays.filter((person) => {
      const plantel = getBirthdayPlantel(person);
      return plantel && selected.has(plantel.key);
    });
  }

  rememberKnownPlanteles(birthdays) {
    const current = listUniquePlanteles(birthdays);
    if (current.length === 0) {
      return;
    }

    const known = readKnownBirthdayPlanteles();
    const merged = mergePlantelLists(known, current).slice(0, 60);
    writeKnownBirthdayPlanteles(merged);
  }

  showPlantelSubscriptionPrompt(planteles, config = {}) {
    if (config.subscriptionPrompt === false) {
      return;
    }

    const availablePlanteles = mergePlantelLists(planteles, readKnownBirthdayPlanteles()).slice(0, 120);
    if (availablePlanteles.length === 0 || hasDismissedBirthdayPlantelPrompt()) {
      return;
    }

    const existing = this.engine.uiLayer.querySelector("[data-eei-widget='birthday-planteles']");
    existing?.remove();

    const card = document.createElement("section");
    card.className = "eei-birthday-plantel-card";
    card.dataset.eeiWidget = "birthday-planteles";
    card.innerHTML = `
      <button class="eei-birthday-plantel-open" type="button" aria-label="Notificaciones de cumpleaños">
        <span class="eei-birthday-plantel-label">Planteles</span>
      </button>
      <button class="eei-birthday-plantel-dismiss" type="button" aria-label="Cerrar">×</button>
    `;

    card.querySelector(".eei-birthday-plantel-open")?.addEventListener("click", (event) => {
      event.preventDefault();
      this.openPlantelSubscriptionModal(availablePlanteles);
    });
    card.querySelector(".eei-birthday-plantel-dismiss")?.addEventListener("click", (event) => {
      event.preventDefault();
      dismissBirthdayPlantelPrompt();
      card.remove();
    });

    this.engine.uiLayer.appendChild(card);
  }

  openPlantelSubscriptionModal(planteles) {
    const existing = this.engine.uiLayer.querySelector("[data-eei-modal='birthday-planteles']");
    existing?.remove();

    const preference = readBirthdayPlantelPreference();
    const allByDefault = preference.mode !== "custom";
    const selected = new Set(allByDefault ? planteles.map((plantel) => plantel.key) : preference.selected || []);

    const modal = document.createElement("section");
    modal.className = "eei-birthday-plantel-modal";
    modal.dataset.eeiModal = "birthday-planteles";
    modal.innerHTML = `
      <div class="eei-birthday-plantel-dialog" role="dialog" aria-modal="true" aria-label="Notificaciones de cumpleaños">
        <button class="eei-modal-close" type="button" aria-label="Cerrar">×</button>
        <h2>Notificaciones de cumpleaños</h2>
        <p>Selecciona de qué planteles deseas recibir notificaciones de cumpleaños.</p>
        <input class="eei-birthday-plantel-search" type="search" placeholder="Buscar plantel" autocomplete="off">
        <div class="eei-birthday-plantel-list">
          ${planteles.map((plantel) => `
            <label>
              <input type="checkbox" value="${escapeAttribute(plantel.key)}" ${selected.has(plantel.key) ? "checked" : ""}>
              <span>${escapeHtml(plantel.name)}</span>
            </label>
          `).join("")}
        </div>
        <div class="eei-birthday-plantel-actions">
          <button type="button" data-action="all">Todos</button>
          <button type="button" data-action="none">Ninguno</button>
          <button type="button" data-action="save">Guardar</button>
        </div>
      </div>
    `;

    const close = () => modal.remove();
    const search = modal.querySelector(".eei-birthday-plantel-search");
    search?.addEventListener("input", () => {
      const query = String(search.value || "").trim().toLowerCase();
      modal.querySelectorAll(".eei-birthday-plantel-list label").forEach((label) => {
        label.hidden = query && !label.textContent.toLowerCase().includes(query);
      });
    });
    modal.querySelector(".eei-modal-close")?.addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        close();
      }
    });
    modal.querySelector("[data-action='all']")?.addEventListener("click", () => {
      writeBirthdayPlantelPreference({ mode: "all", selected: [], updatedAt: new Date().toISOString() });
      close();
    });
    modal.querySelector("[data-action='none']")?.addEventListener("click", () => {
      writeBirthdayPlantelPreference({ mode: "custom", selected: [], updatedAt: new Date().toISOString() });
      close();
    });
    modal.querySelector("[data-action='save']")?.addEventListener("click", () => {
      const checked = [...modal.querySelectorAll("input[type='checkbox']:checked")].map((input) => input.value);
      const allSelected = checked.length === planteles.length;
      writeBirthdayPlantelPreference({
        mode: allSelected ? "all" : "custom",
        selected: allSelected ? [] : checked,
        updatedAt: new Date().toISOString()
      });
      close();
    });

    this.engine.uiLayer.appendChild(modal);
  }

  hasShown(date) {
    try {
      return window.sessionStorage.getItem(`eei:birthday:${date}`) === "shown";
    } catch {
      return false;
    }
  }

  markShown(date) {
    try {
      window.sessionStorage.setItem(`eei:birthday:${date}`, "shown");
    } catch {
      // Storage can be blocked by browser policy; visual celebration can continue.
    }
  }

  release() {
    this.disposeRelease();
    this.group = new THREE.Group();
    this.group.name = "EEI Birthday Release";
    this.engine.scene.add(this.group);
    this.releaseStartedAt = performance.now() / 1000;

    this.createConfetti();
    this.createBalloons();
  }

  createConfetti() {
    const colors = [0xef4444, 0x2563eb, 0x84cc16, 0xf59e0b, 0xf8fafc, 0x14b8a6];
    const totalCount = 264;
    const buckets = colors.map((color) => ({ color, pieces: [] }));
    for (let index = 0; index < totalCount; index += 1) {
      const piece = {
        x: randomBetween(-this.engine.size.width / 2, this.engine.size.width / 2),
        y: this.engine.size.height / 2 + randomBetween(10, this.engine.size.height * 0.45),
        z: randomBetween(-180, 420),
        vx: randomBetween(-45, 45),
        vy: randomBetween(-260, -90),
        spinX: randomBetween(-6, 6),
        spinY: randomBetween(-7, 7),
        spinZ: randomBetween(-8, 8),
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI,
        rz: Math.random() * Math.PI,
        scale: randomBetween(0.75, 1.8)
      };
      buckets[index % buckets.length].pieces.push(piece);
    }

    const meshes = buckets.map((bucket) => {
      const geometry = new THREE.PlaneGeometry(10, 5);
      const material = new THREE.MeshBasicMaterial({
        color: bucket.color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.96,
        depthWrite: false
      });
      const mesh = new THREE.InstancedMesh(geometry, material, bucket.pieces.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.name = "EEI Birthday Confetti";
      this.group.add(mesh);
      return { mesh, pieces: bucket.pieces };
    });

    this.confetti = { meshes, bornAt: performance.now() / 1000 };
  }

  createBalloons() {
    const colors = [0xf97316, 0xfbbf24, 0x38bdf8, 0x10b981, 0xf8fafc, 0x8b5cf6, 0x14b8a6];
    const geometry = new THREE.SphereGeometry(1, 32, 18);
    const stringMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.64
    });

    for (let index = 0; index < 9; index += 1) {
      const radius = randomBetween(23, 38);
      const material = new THREE.MeshStandardMaterial({
        color: colors[index % colors.length],
        roughness: 0.34,
        metalness: 0.02,
        transparent: true,
        opacity: 0.92
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.scale.set(radius * 0.86, radius * 1.15, radius * 0.86);

      const stringGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, -radius * 1.08, 0),
        new THREE.Vector3(0, -radius * 2.7, 0)
      ]);
      const line = new THREE.Line(stringGeometry, stringMaterial.clone());

      const cluster = new THREE.Group();
      cluster.add(mesh, line);
      cluster.position.set(
        randomBetween(-this.engine.size.width / 2, this.engine.size.width / 2),
        -this.engine.size.height / 2 - randomBetween(40, 260),
        randomBetween(-160, 320)
      );
      cluster.rotation.z = randomBetween(-0.18, 0.18);
      cluster.userData.velocity = randomBetween(38, 86);
      cluster.userData.wobble = randomBetween(0.5, 1.7);
      cluster.userData.phase = Math.random() * Math.PI * 2;
      this.balloons.push(cluster);
      this.group.add(cluster);
    }
  }

  update(dt, elapsed) {
    if (!this.active) {
      return;
    }

    if (this.confetti) {
      const { meshes, bornAt } = this.confetti;
      const age = elapsed - bornAt;
      const bottom = -this.engine.size.height / 2 - 80;
      let globalIndex = 0;
      for (const bucket of meshes) {
        for (let index = 0; index < bucket.pieces.length; index += 1) {
          const piece = bucket.pieces[index];
          piece.vy -= 130 * dt;
          piece.x += piece.vx * dt + Math.sin(elapsed * 1.6 + globalIndex) * 12 * dt;
          piece.y += piece.vy * dt;
          piece.rx += piece.spinX * dt;
          piece.ry += piece.spinY * dt;
          piece.rz += piece.spinZ * dt;

          this.dummy.position.set(piece.x, piece.y, piece.z);
          this.dummy.rotation.set(piece.rx, piece.ry, piece.rz);
          this.dummy.scale.setScalar(piece.scale);
          this.dummy.updateMatrix();
          bucket.mesh.setMatrixAt(index, this.dummy.matrix);

          if (piece.y < bottom && age < 7) {
            piece.y = this.engine.size.height / 2 + randomBetween(20, 160);
            piece.x = randomBetween(-this.engine.size.width / 2, this.engine.size.width / 2);
            piece.vy = randomBetween(-210, -100);
          }

          globalIndex += 1;
        }
        bucket.mesh.instanceMatrix.needsUpdate = true;
        bucket.mesh.material.opacity = Math.max(0, Math.min(0.96, 1 - Math.max(0, age - 7) / 2.4));
      }
    }

    for (const balloon of this.balloons) {
      balloon.position.y += balloon.userData.velocity * dt;
      balloon.position.x += Math.sin(elapsed * balloon.userData.wobble + balloon.userData.phase) * 18 * dt;
      balloon.rotation.z = Math.sin(elapsed * 0.7 + balloon.userData.phase) * 0.1;
    }

    if (elapsed - this.releaseStartedAt > 10.5) {
      this.disposeRelease();
    }
  }

  disposeRelease() {
    if (!this.group) {
      return;
    }

    this.engine.scene.remove(this.group);
    disposeObject3D(this.group);
    this.group = null;
    this.confetti = null;
    this.balloons = [];
  }

  stop() {
    this.active = false;
    this.disposeRelease();
    this.engine.uiLayer?.querySelector("[data-eei-widget='birthday-planteles']")?.remove();
    this.engine.uiLayer?.querySelector("[data-eei-modal='birthday-planteles']")?.remove();
  }
}

class SnowModule {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.group = null;
    this.layers = [];
    this.config = {};
    this.snowMap = null;
  }

  setEnabled(enabled, config = {}) {
    this.config = config;
    if (!enabled) {
      this.stop();
      return;
    }
    if (!this.active) {
      this.start();
    }
  }

  start() {
    this.active = true;
    this.group = new THREE.Group();
    this.group.name = "EEI Snow";
    this.engine.scene.add(this.group);
    this.snowMap = this.engine.getParticleAtlasTile(3);
    this.createLayers();
  }

  createLayers() {
    const baseCount = Math.round(90 + 190 * Number(this.config.intensity || 0.8));
    const layerSettings = [
      { count: baseCount, size: 11, speed: 42, opacity: 0.74, z: 120 },
      { count: Math.round(baseCount * 0.7), size: 6, speed: 68, opacity: 0.46, z: 20 },
      { count: Math.round(baseCount * 0.42), size: 17, speed: 28, opacity: 0.32, z: 260 }
    ];

    for (const settings of layerSettings) {
      const positions = new Float32Array(settings.count * 3);
      const drifts = new Float32Array(settings.count);

      for (let index = 0; index < settings.count; index += 1) {
        positions[index * 3] = randomBetween(-this.engine.size.width / 2, this.engine.size.width / 2);
        positions[index * 3 + 1] = randomBetween(-this.engine.size.height / 2, this.engine.size.height / 2);
        positions[index * 3 + 2] = randomBetween(-80, settings.z);
        drifts[index] = randomBetween(0.4, 1.8);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        size: settings.size,
        color: 0xeaf8ff,
        map: this.snowMap,
        transparent: true,
        opacity: settings.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
      const points = new THREE.Points(geometry, material);
      points.name = "EEI Snow Layer";
      this.layers.push({ points, positions, drifts, speed: settings.speed });
      this.group.add(points);
    }
  }

  update(dt, elapsed) {
    if (!this.active) {
      return;
    }

    const width = this.engine.size.width;
    const height = this.engine.size.height;
    const wind = Number(this.config.wind || 0.5);

    for (const layer of this.layers) {
      const positions = layer.positions;
      for (let index = 0; index < positions.length / 3; index += 1) {
        const offset = index * 3;
        positions[offset] += (Math.sin(elapsed * 0.55 + layer.drifts[index] * 4) * 18 + wind * 34) * dt;
        positions[offset + 1] -= layer.speed * layer.drifts[index] * dt;

        if (positions[offset + 1] < -height / 2 - 32) {
          positions[offset + 1] = height / 2 + randomBetween(8, 80);
          positions[offset] = randomBetween(-width / 2, width / 2);
        }

        if (positions[offset] > width / 2 + 48) {
          positions[offset] = -width / 2 - 48;
        } else if (positions[offset] < -width / 2 - 48) {
          positions[offset] = width / 2 + 48;
        }
      }
      layer.points.geometry.attributes.position.needsUpdate = true;
    }
  }

  stop() {
    if (!this.active) {
      return;
    }

    this.active = false;
    if (this.group) {
      this.engine.scene.remove(this.group);
      disposeObject3D(this.group);
      this.group = null;
    }
    this.layers = [];
    this.engine.releaseTransientTexture(this.snowMap);
    this.snowMap = null;
  }
}

class FireworksModule {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.group = null;
    this.bursts = [];
    this.timer = 0;
    this.config = {};
    this.sparkMap = null;
    this.startedAt = 0;
    this.spawning = false;
    this.completed = false;
  }

  setEnabled(enabled, config = {}) {
    this.config = config;
    if (!enabled) {
      this.stop({ reset: true });
      return;
    }
    if (this.active || this.completed) {
      return;
    }
    this.start();
  }

  start() {
    this.active = true;
    this.completed = false;
    this.spawning = true;
    this.startedAt = performance.now();
    this.group = new THREE.Group();
    this.group.name = "EEI Fireworks";
    this.engine.scene.add(this.group);
    this.sparkMap = this.engine.getParticleAtlasTile(2);
    this.timer = 0;
  }

  spawnBurst() {
    if (!this.spawning) {
      return;
    }
    const count = Math.round(70 + 70 * Number(this.config.intensity || 0.75));
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const palette = [0xffcf33, 0xffffff, 0x38bdf8, 0xef4444, 0xa3e635, 0xc084fc];
    const origin = new THREE.Vector3(
      randomBetween(-this.engine.size.width * 0.34, this.engine.size.width * 0.34),
      randomBetween(this.engine.size.height * 0.04, this.engine.size.height * 0.36),
      randomBetween(-40, 300)
    );

    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const elevation = randomBetween(-0.55, 0.55);
      const speed = randomBetween(85, 270);
      const offset = index * 3;
      positions[offset] = origin.x;
      positions[offset + 1] = origin.y;
      positions[offset + 2] = origin.z;
      velocities[offset] = Math.cos(angle) * speed;
      velocities[offset + 1] = Math.sin(angle) * speed + elevation * 90;
      velocities[offset + 2] = randomBetween(-70, 90);

      const color = new THREE.Color(palette[index % palette.length]);
      colors[offset] = color.r;
      colors[offset + 1] = color.g;
      colors[offset + 2] = color.b;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 16,
      vertexColors: true,
      map: this.sparkMap,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(geometry, material);
    this.group.add(points);
    this.bursts.push({ points, positions, velocities, age: 0, life: randomBetween(1.15, 1.9) });
  }

  update(dt) {
    if (!this.active) {
      return;
    }

    const durationMs = Math.max(2500, Number(this.config.durationMs || DEFAULT_CONFIG.festivities.new_year.durationMs || 14000));
    if (performance.now() - this.startedAt >= durationMs) {
      this.spawning = false;
    }

    this.timer -= dt;
    if (this.spawning && this.timer <= 0) {
      this.spawnBurst();
      this.timer = randomBetween(0.65, 1.35);
    }

    for (let burstIndex = this.bursts.length - 1; burstIndex >= 0; burstIndex -= 1) {
      const burst = this.bursts[burstIndex];
      burst.age += dt;
      const positions = burst.positions;
      const velocities = burst.velocities;

      for (let index = 0; index < positions.length / 3; index += 1) {
        const offset = index * 3;
        velocities[offset + 1] -= 118 * dt;
        positions[offset] += velocities[offset] * dt;
        positions[offset + 1] += velocities[offset + 1] * dt;
        positions[offset + 2] += velocities[offset + 2] * dt;
      }

      burst.points.geometry.attributes.position.needsUpdate = true;
      burst.points.material.opacity = Math.max(0, 1 - burst.age / burst.life);

      if (burst.age >= burst.life) {
        this.group.remove(burst.points);
        disposeObject3D(burst.points);
        this.bursts.splice(burstIndex, 1);
      }
    }

    if (!this.spawning && this.bursts.length === 0) {
      this.stop({ completed: true });
    }
  }

  stop({ completed = false, reset = false } = {}) {
    if (!this.active && !this.group) {
      if (reset) {
        this.completed = false;
      }
      return;
    }

    this.active = false;
    this.spawning = false;
    this.completed = completed ? true : reset ? false : this.completed;
    if (this.group) {
      this.engine.scene.remove(this.group);
      disposeObject3D(this.group);
      this.group = null;
    }
    this.bursts = [];
    this.engine.releaseTransientTexture(this.sparkMap);
    this.sparkMap = null;
  }
}

class MundialModule {
  constructor(engine) {
    this.engine = engine;
    this.active = false;
    this.group = null;
    this.balls = [];
    this.geometry = null;
    this.material = null;
    this.config = {};
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.drag = null;
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  setEnabled(enabled, config = {}) {
    this.config = config;
    if (!enabled) {
      this.stop();
      return;
    }
    if (!this.active) {
      this.start();
    }
  }

  start() {
    this.active = true;
    this.group = new THREE.Group();
    this.group.name = "EEI Mundial 2026";
    this.engine.scene.add(this.group);

    const texture = this.engine.getTexture("trionda", this.engine.assetUrl("textures", "trionda"), {
      colorSpace: THREE.SRGBColorSpace
    });
    this.geometry = new THREE.SphereGeometry(1, 48, 24);
    this.material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.55,
      metalness: 0.02
    });

    const configuredCount = Number(this.config.ballCount);
    const count = Number.isFinite(configuredCount)
      ? Math.max(0, Math.min(8, Math.round(configuredCount)))
      : Math.max(1, Math.round(2 + 5 * Number(this.config.intensity || 0.42)));

    for (let index = 0; index < count; index += 1) {
      this.spawnBall(index);
    }

    if (this.config.ballInteraction !== false) {
      document.addEventListener("pointerdown", this.handlePointerDown, {
        capture: true,
        passive: false
      });
    }

    this.loadMatches();
  }

  spawnBall(index) {
    if (!this.group || !this.geometry || !this.material) {
      return;
    }

    const width = this.engine.size.width;
    const height = this.engine.size.height;
    const radius = randomBetween(22, 34);
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.scale.setScalar(radius);
    mesh.position.set(
      randomBetween(-width / 2 + radius, width / 2 - radius),
      height / 2 + radius + index * randomBetween(12, 42),
      randomBetween(-60, 220)
    );

    const mass = radius * radius;
    const lifetimeMs = Math.max(6000, Number(this.config.ballLifetimeMs || 18000));
    const autoExitMs = Math.max(2500, Number(this.config.ballAutoExitAfterMs || 10500));
    const bornAt = performance.now();
    mesh.userData.radius = radius;
    mesh.userData.mass = mass;
    mesh.userData.createdAt = bornAt;
    mesh.userData.autoExitAt = bornAt + autoExitMs + index * randomBetween(700, 1600);
    mesh.userData.removeAt = bornAt + lifetimeMs + index * randomBetween(300, 900);
    mesh.userData.exiting = false;
    mesh.userData.dragging = false;
    mesh.userData.velocity = new THREE.Vector2(randomBetween(-70, 70), randomBetween(-55, 15));
    mesh.userData.angularVelocity = new THREE.Vector3(randomBetween(-1.3, 1.3), randomBetween(-2, 2), randomBetween(-1.3, 1.3));
    this.balls.push(mesh);
    this.group.add(mesh);
  }

  async loadMatches() {
    try {
      const apiUrl = this.config.sportsApiUrl || DEFAULT_CONFIG.festivities.mundial_2026.sportsApiUrl;
      const separator = String(apiUrl || "").includes("?") ? "&" : "?";
      const today = todayInTimeZone(DEFAULT_TIMEZONE);
      const response = await fetch(`${apiUrl}${separator}date=${encodeURIComponent(today)}`, {
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json"
        }
      });
      const data = response.ok ? await response.json() : { matches: [] };
      if (this.active) {
        this.engine.setWorldCupWidget(this.config, Array.isArray(data.matches) ? data.matches : []);
      }
    } catch {
      if (this.active) {
        this.engine.setWorldCupWidget(this.config, []);
      }
    }
  }

  handlePointerDown(event) {
    if (!this.active || !this.balls.length || !this.engine.camera) {
      return;
    }

    const ball = this.pickBall(event);
    if (!ball) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();

    const world = this.clientToWorld(event.clientX, event.clientY);
    ball.userData.dragging = true;
    ball.userData.velocity.set(0, 0);
    ball.userData.angularVelocity.multiplyScalar(0.35);
    this.drag = {
      ball,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastX: world.x,
      lastY: world.y,
      lastAt: performance.now(),
      moved: false,
      offsetX: ball.position.x - world.x,
      offsetY: ball.position.y - world.y
    };

    document.addEventListener("pointermove", this.handlePointerMove, { capture: true, passive: false });
    document.addEventListener("pointerup", this.handlePointerUp, { capture: true, passive: false });
    document.addEventListener("pointercancel", this.handlePointerUp, { capture: true, passive: false });
  }

  handlePointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();

    const now = performance.now();
    const world = this.clientToWorld(event.clientX, event.clientY);
    const ball = this.drag.ball;
    const dtMs = Math.max(8, now - this.drag.lastAt);
    const nextX = world.x + this.drag.offsetX;
    const nextY = world.y + this.drag.offsetY;
    const dx = nextX - ball.position.x;
    const dy = nextY - ball.position.y;

    ball.position.x = nextX;
    ball.position.y = nextY;
    ball.userData.velocity.set((world.x - this.drag.lastX) / dtMs * 1000, (world.y - this.drag.lastY) / dtMs * 1000);
    ball.userData.angularVelocity.x += dy * 0.006;
    ball.userData.angularVelocity.y += dx * 0.006;

    if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 8) {
      this.drag.moved = true;
    }

    this.drag.lastClientX = event.clientX;
    this.drag.lastClientY = event.clientY;
    this.drag.lastX = world.x;
    this.drag.lastY = world.y;
    this.drag.lastAt = now;
  }

  handlePointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();

    const { ball, moved } = this.drag;
    if (ball && !ball.userData.removed) {
      ball.userData.dragging = false;
      if (!moved) {
        const world = this.clientToWorld(event.clientX, event.clientY);
        const direction = new THREE.Vector2(ball.position.x - world.x, ball.position.y - world.y + 40);
        if (direction.lengthSq() < 0.01) {
          direction.set(ball.position.x >= 0 ? 1 : -1, 0.72);
        }
        this.kickBall(ball, direction.normalize(), 2050);
      } else {
        const velocity = ball.userData.velocity;
        velocity.x = clamp(velocity.x, -1600, 1600);
        velocity.y = clamp(velocity.y, -1200, 1200);
      }
    }

    this.drag = null;
    document.removeEventListener("pointermove", this.handlePointerMove, { capture: true });
    document.removeEventListener("pointerup", this.handlePointerUp, { capture: true });
    document.removeEventListener("pointercancel", this.handlePointerUp, { capture: true });
  }

  pickBall(event) {
    const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    this.pointer.set((event.clientX / width) * 2 - 1, -(event.clientY / height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.engine.camera);
    const intersects = this.raycaster.intersectObjects(this.balls.filter((ball) => !ball.userData.removed), false);
    return intersects.length ? intersects[0].object : null;
  }

  clientToWorld(clientX, clientY) {
    const width = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const height = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    return new THREE.Vector2(clientX - width / 2, height / 2 - clientY);
  }

  kickBall(ball, direction = null, strength = 1500) {
    if (!ball || ball.userData.removed) {
      return;
    }

    const dir = direction || new THREE.Vector2(randomBetween(-1, 1), randomBetween(0.45, 1)).normalize();
    const velocity = ball.userData.velocity;
    velocity.x = dir.x * strength + randomBetween(-120, 120);
    velocity.y = dir.y * strength + randomBetween(80, 260);
    ball.userData.exiting = true;
    ball.userData.dragging = false;
    ball.userData.removeAt = performance.now() + 4200;
    ball.userData.angularVelocity.multiplyScalar(4.2);
  }

  update(dt) {
    if (!this.active) {
      return;
    }

    const now = performance.now();
    const gravity = -980;
    const width = this.engine.size.width;
    const height = this.engine.size.height;
    const wallRestitution = 0.68;
    const floorRestitution = 0.48;
    const floorFriction = 0.78;
    const airDrag = Math.pow(0.989, dt * 60);

    for (const ball of [...this.balls]) {
      if (ball.userData.removed) {
        continue;
      }

      if (!ball.userData.exiting && !ball.userData.dragging && now >= ball.userData.autoExitAt) {
        const direction = new THREE.Vector2(ball.position.x >= 0 ? 1 : -1, randomBetween(0.35, 0.9)).normalize();
        this.kickBall(ball, direction, randomBetween(1320, 1680));
      }

      const velocity = ball.userData.velocity;
      const radius = ball.userData.radius;

      if (!ball.userData.dragging) {
        velocity.y += gravity * dt;
        velocity.multiplyScalar(airDrag);
        ball.position.x += velocity.x * dt;
        ball.position.y += velocity.y * dt;
      }

      const left = -width / 2 + radius;
      const right = width / 2 - radius;
      const bottom = -height / 2 + radius + 8;
      const top = height / 2 - radius;

      if (!ball.userData.exiting && !ball.userData.dragging) {
        if (ball.position.x < left) {
          ball.position.x = left;
          velocity.x = Math.abs(velocity.x) * wallRestitution;
        } else if (ball.position.x > right) {
          ball.position.x = right;
          velocity.x = -Math.abs(velocity.x) * wallRestitution;
        }

        if (ball.position.y < bottom) {
          ball.position.y = bottom;
          if (Math.abs(velocity.y) > 42) {
            velocity.y = Math.abs(velocity.y) * floorRestitution;
          } else {
            velocity.y = 0;
          }
          velocity.x *= floorFriction;
          if (Math.abs(velocity.x) < 10) {
            velocity.x = 0;
          }
        } else if (ball.position.y > top) {
          ball.position.y = top;
          velocity.y = -Math.abs(velocity.y) * 0.22;
        }
      }

      const angularVelocity = ball.userData.angularVelocity;
      ball.rotation.x += angularVelocity.x * dt + velocity.y * dt * 0.004;
      ball.rotation.y += angularVelocity.y * dt + velocity.x * dt * 0.004;
      ball.rotation.z += angularVelocity.z * dt;
      angularVelocity.multiplyScalar(Math.pow(0.988, dt * 60));
      if (!ball.userData.dragging && Math.abs(velocity.x) < 0.1 && Math.abs(velocity.y) < 0.1) {
        angularVelocity.multiplyScalar(Math.pow(0.92, dt * 60));
      }

      const outsideMargin = Math.max(180, radius * 6);
      const outside = ball.position.x < -width / 2 - outsideMargin || ball.position.x > width / 2 + outsideMargin || ball.position.y < -height / 2 - outsideMargin || ball.position.y > height / 2 + outsideMargin;
      if (outside || now >= ball.userData.removeAt) {
        this.removeBall(ball);
      }
    }

    this.resolveBallCollisions();
  }

  resolveBallCollisions() {
    const balls = this.balls.filter((ball) => !ball.userData.removed && !ball.userData.exiting && !ball.userData.dragging);
    for (let i = 0; i < balls.length; i += 1) {
      for (let j = i + 1; j < balls.length; j += 1) {
        const a = balls[i];
        const b = balls[j];
        const dx = b.position.x - a.position.x;
        const dy = b.position.y - a.position.y;
        const minDistance = a.userData.radius + b.userData.radius;
        const distanceSq = dx * dx + dy * dy;
        if (distanceSq <= 0.0001 || distanceSq >= minDistance * minDistance) {
          continue;
        }

        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = minDistance - distance;
        const aMass = a.userData.mass || 1;
        const bMass = b.userData.mass || 1;
        const totalMass = aMass + bMass;
        a.position.x -= nx * overlap * (bMass / totalMass);
        a.position.y -= ny * overlap * (bMass / totalMass);
        b.position.x += nx * overlap * (aMass / totalMass);
        b.position.y += ny * overlap * (aMass / totalMass);

        const av = a.userData.velocity;
        const bv = b.userData.velocity;
        const relativeVelocityX = bv.x - av.x;
        const relativeVelocityY = bv.y - av.y;
        const velocityAlongNormal = relativeVelocityX * nx + relativeVelocityY * ny;
        if (velocityAlongNormal > 0) {
          continue;
        }

        const restitution = 0.62;
        const impulse = -(1 + restitution) * velocityAlongNormal / (1 / aMass + 1 / bMass);
        const impulseX = impulse * nx;
        const impulseY = impulse * ny;
        av.x -= impulseX / aMass;
        av.y -= impulseY / aMass;
        bv.x += impulseX / bMass;
        bv.y += impulseY / bMass;

        a.userData.angularVelocity.z -= impulseX * 0.0008;
        b.userData.angularVelocity.z += impulseX * 0.0008;
      }
    }
  }

  removeBall(ball) {
    if (!ball || ball.userData.removed) {
      return;
    }

    ball.userData.removed = true;
    this.group?.remove(ball);
    this.balls = this.balls.filter((item) => item !== ball);
  }

  stop() {
    if (!this.active) {
      return;
    }

    this.active = false;
    document.removeEventListener("pointerdown", this.handlePointerDown, { capture: true });
    document.removeEventListener("pointermove", this.handlePointerMove, { capture: true });
    document.removeEventListener("pointerup", this.handlePointerUp, { capture: true });
    document.removeEventListener("pointercancel", this.handlePointerUp, { capture: true });
    this.drag = null;
    this.engine.clearWorldCupWidget();
    if (this.group) {
      this.engine.scene.remove(this.group);
      disposeObject3D(this.group);
      this.group = null;
    }
    this.balls = [];
    this.geometry = null;
    this.material = null;
  }
}
function disposeObject3D(object) {
  const geometries = new Set();
  const materialSet = new Set();

  object.traverse((child) => {
    if (child.geometry) {
      geometries.add(child.geometry);
    }

    if (child.material) {
      const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of childMaterials) {
        materialSet.add(material);
      }
    }
  });

  for (const geometry of geometries) {
    geometry.dispose();
  }

  for (const material of materialSet) {
    material.dispose();
  }
}

function normalizeConfig(config) {
  return deepMerge(DEFAULT_CONFIG, config || {});
}

function deepMerge(base, override) {
  const output = Array.isArray(base) ? [...base] : { ...base };
  if (!override || typeof override !== "object") {
    return output;
  }

  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      output[key] = [...value];
    } else if (value && typeof value === "object") {
      output[key] = deepMerge(output[key] && typeof output[key] === "object" ? output[key] : {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function waitForBody() {
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (document.body) {
        window.clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms)) {
    return "TBD";
  }
  if (ms <= 0) {
    return "00m";
  }
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${String(hours).padStart(2, "0")}h`;
  }
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m`;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createParticleCanvasTexture(index) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);

  if (index === 3) {
    ctx.translate(64, 64);
    ctx.strokeStyle = "rgba(235, 249, 255, 0.95)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(125, 211, 252, 0.55)";
    ctx.shadowBlur = 8;
    for (let arm = 0; arm < 6; arm += 1) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, -44);
      ctx.moveTo(0, -24);
      ctx.lineTo(-10, -34);
      ctx.moveTo(0, -24);
      ctx.lineTo(10, -34);
      ctx.stroke();
    }
  } else {
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 58);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.16, "rgba(255,221,120,0.98)");
    gradient.addColorStop(0.38, "rgba(56,189,248,0.62)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(64, 12);
    ctx.lineTo(64, 116);
    ctx.moveTo(12, 64);
    ctx.lineTo(116, 64);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }
  return String(value).replace(/["\\]/g, "\\$&");
}

function safeLocalStorageGet(key) {
  try {
    return window.localStorage?.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeLocalStorageSet(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Storage can be blocked in embedded or private browsing contexts.
  }
}


function normalizeBirthdayRecord(person) {
  if (!person || typeof person !== "object") {
    return {};
  }

  const plantel = normalizePlantelEntity(person.plantel || person.plantelOriginal, person.plantelId || "", person.plantelName || person.campus || person.school || person.sede || "");
  const plantelFisico = normalizePlantelEntity(person.plantelFisico || person.plantel_fisico, person.plantelFisicoId || person.plantel_fisico_id || "", person.plantelFisicoName || "");
  const notificationPlantel = plantelFisico || plantel;
  const displayName = person.displayName || person.name || person.nombreCompleto || person.fullName || person.nombre || person.colaborador?.displayName || person.colaborador?.name || "Colaborador";

  return {
    ...person,
    name: displayName,
    displayName,
    puesto: person.puesto || person.colaborador?.puesto || person.position || person.cargo || "",
    plantel: notificationPlantel?.name || person.plantelName || (typeof person.plantel === "string" ? person.plantel : ""),
    plantelName: notificationPlantel?.name || person.plantelName || "",
    plantelKey: notificationPlantel?.key || person.plantelKey || "",
    plantelOriginal: plantel,
    plantelFisico
  };
}

function normalizePlantelEntity(value, fallbackId = "", fallbackName = "") {
  if (value && typeof value === "object") {
    const id = value.id ?? value.plantelId ?? value.value ?? fallbackId ?? "";
    const name = value.name || value.nombre || value.label || value.displayName || fallbackName || "";
    const label = value.label || name;
    if (!id && !name && !label) {
      return null;
    }
    const plantel = {
      id: id === null || id === undefined ? "" : String(id),
      name: String(name || label || id || "Plantel"),
      label: String(label || name || id || "Plantel")
    };
    plantel.key = getPlantelKey(plantel);
    return plantel;
  }

  const name = fallbackName || value || "";
  if (!fallbackId && !name) {
    return null;
  }
  const plantel = {
    id: fallbackId === null || fallbackId === undefined ? "" : String(fallbackId),
    name: String(name || fallbackId || "Plantel"),
    label: String(name || fallbackId || "Plantel")
  };
  plantel.key = getPlantelKey(plantel);
  return plantel;
}

function getPlantelKey(plantel) {
  if (!plantel) {
    return "";
  }
  if (plantel.key) {
    return String(plantel.key);
  }
  if (plantel.id) {
    return `id:${String(plantel.id)}`;
  }
  const name = plantel.name || plantel.label || "";
  return name ? `name:${slugifyPlantel(name)}` : "";
}

function slugifyPlantel(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getBirthdayPlantel(person) {
  const normalized = normalizeBirthdayRecord(person);
  return normalized.plantelFisico || normalized.plantelOriginal || (normalized.plantelName ? normalizePlantelEntity(null, normalized.plantelId || "", normalized.plantelName) : null);
}

function listUniquePlanteles(birthdays) {
  const map = new Map();
  for (const person of birthdays || []) {
    const plantel = getBirthdayPlantel(person);
    if (plantel?.key && !map.has(plantel.key)) {
      map.set(plantel.key, plantel);
    }
  }
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
}

function mergePlantelLists(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const plantel of list || []) {
      const normalized = normalizePlantelEntity(plantel, plantel?.id || "", plantel?.name || "");
      if (normalized?.key && !map.has(normalized.key)) {
        map.set(normalized.key, normalized);
      }
    }
  }
  return [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "es"));
}

const BIRTHDAY_PLANTEL_DISMISSED_KEY = "eei:birthday:planteles-dismissed-until:v2";
const BIRTHDAY_PLANTEL_DISMISS_MS = 7 * 24 * 60 * 60 * 1000;

function hasDismissedBirthdayPlantelPrompt() {
  const until = Number(safeLocalStorageGet(BIRTHDAY_PLANTEL_DISMISSED_KEY) || 0);
  return Number.isFinite(until) && until > Date.now();
}

function dismissBirthdayPlantelPrompt() {
  safeLocalStorageSet(BIRTHDAY_PLANTEL_DISMISSED_KEY, String(Date.now() + BIRTHDAY_PLANTEL_DISMISS_MS));
}

const BIRTHDAY_PLANTEL_PREF_KEY = "eei:birthday:planteles:v1";
const BIRTHDAY_PLANTEL_KNOWN_KEY = "eei:birthday:known-planteles:v1";
const BIRTHDAY_PLANTEL_PREF_COOKIE = "eei_bday_planteles";
const BIRTHDAY_PLANTEL_KNOWN_COOKIE = "eei_bday_known_planteles";

function readBirthdayPlantelPreference() {
  return readJsonStorage(BIRTHDAY_PLANTEL_PREF_KEY, BIRTHDAY_PLANTEL_PREF_COOKIE, { mode: "all", selected: [] });
}

function writeBirthdayPlantelPreference(value) {
  writeJsonStorage(BIRTHDAY_PLANTEL_PREF_KEY, BIRTHDAY_PLANTEL_PREF_COOKIE, value);
}

function readKnownBirthdayPlanteles() {
  const value = readJsonStorage(BIRTHDAY_PLANTEL_KNOWN_KEY, BIRTHDAY_PLANTEL_KNOWN_COOKIE, []);
  return Array.isArray(value) ? value : [];
}

function writeKnownBirthdayPlanteles(value) {
  writeJsonStorage(BIRTHDAY_PLANTEL_KNOWN_KEY, BIRTHDAY_PLANTEL_KNOWN_COOKIE, value);
}

function readJsonStorage(localKey, cookieName, fallback) {
  const cookieValue = readCookie(cookieName);
  const localValue = safeLocalStorageGet(localKey);
  for (const raw of [cookieValue, localValue]) {
    if (!raw) {
      continue;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Try the next storage source.
    }
  }
  return fallback;
}

function writeJsonStorage(localKey, cookieName, value) {
  const serialized = JSON.stringify(value);
  safeLocalStorageSet(localKey, serialized);
  writeCookie(cookieName, serialized);
}

function readCookie(name) {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function writeCookie(name, value) {
  try {
    const encoded = encodeURIComponent(value);
    const domain = getCookieDomainForBirthdayPreference();
    document.cookie = `${name}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${domain ? `; Domain=${domain}` : ""}`;
  } catch {
    // Cookie writes can fail on restricted origins; localStorage still keeps current-origin preferences.
  }
}

function getCookieDomainForBirthdayPreference() {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname === "casitaapps.com" || hostname.endsWith(".casitaapps.com")) {
    return ".casitaapps.com";
  }
  if (hostname === "casitaiedis.edu.mx" || hostname.endsWith(".casitaiedis.edu.mx")) {
    return ".casitaiedis.edu.mx";
  }
  return "";
}

function teamFlag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  const code = normalized.replace(/[^a-z]/g, "").toUpperCase();
  const direct = FLAG_BY_CODE[code] || FLAG_BY_NAME[normalized];
  if (direct) {
    return direct;
  }
  return "🏳️";
}

const FLAG_BY_CODE = Object.freeze({
  ARG: "🇦🇷", AUS: "🇦🇺", AUT: "🇦🇹", BEL: "🇧🇪", BIH: "🇧🇦", BRA: "🇧🇷", CAN: "🇨🇦", CIV: "🇨🇮", CMR: "🇨🇲", COD: "🇨🇩", COL: "🇨🇴", CPV: "🇨🇻", CRO: "🇭🇷", CZE: "🇨🇿", CZECHIA: "🇨🇿", DEN: "🇩🇰", ECU: "🇪🇨", EGY: "🇪🇬", ENG: "🏴", FRA: "🇫🇷", GER: "🇩🇪", GHA: "🇬🇭", JPN: "🇯🇵", KOR: "🇰🇷", MAR: "🇲🇦", MEX: "🇲🇽", NED: "🇳🇱", NOR: "🇳🇴", PAR: "🇵🇾", POR: "🇵🇹", SEN: "🇸🇳", SPA: "🇪🇸", ESP: "🇪🇸", SWE: "🇸🇪", SUI: "🇨🇭", SWI: "🇨🇭", USA: "🇺🇸", URU: "🇺🇾"
});

const FLAG_BY_NAME = Object.freeze({
  "argentina": "🇦🇷",
  "australia": "🇦🇺",
  "austria": "🇦🇹",
  "belgium": "🇧🇪",
  "belgica": "🇧🇪",
  "bélgica": "🇧🇪",
  "bosnia and herzegovina": "🇧🇦",
  "bosnia": "🇧🇦",
  "brazil": "🇧🇷",
  "brasil": "🇧🇷",
  "canada": "🇨🇦",
  "canadá": "🇨🇦",
  "cape verde": "🇨🇻",
  "cabo verde": "🇨🇻",
  "colombia": "🇨🇴",
  "croatia": "🇭🇷",
  "croacia": "🇭🇷",
  "czechia": "🇨🇿",
  "dinamarca": "🇩🇰",
  "dr congo": "🇨🇩",
  "ecuador": "🇪🇨",
  "egypt": "🇪🇬",
  "egipto": "🇪🇬",
  "england": "🏴",
  "france": "🇫🇷",
  "francia": "🇫🇷",
  "germany": "🇩🇪",
  "alemania": "🇩🇪",
  "ghana": "🇬🇭",
  "ivory coast": "🇨🇮",
  "cote d'ivoire": "🇨🇮",
  "côte d’ivoire": "🇨🇮",
  "japan": "🇯🇵",
  "japón": "🇯🇵",
  "korea republic": "🇰🇷",
  "south korea": "🇰🇷",
  "corea del sur": "🇰🇷",
  "mexico": "🇲🇽",
  "méxico": "🇲🇽",
  "morocco": "🇲🇦",
  "marruecos": "🇲🇦",
  "netherlands": "🇳🇱",
  "países bajos": "🇳🇱",
  "norway": "🇳🇴",
  "noruega": "🇳🇴",
  "paraguay": "🇵🇾",
  "portugal": "🇵🇹",
  "senegal": "🇸🇳",
  "spain": "🇪🇸",
  "españa": "🇪🇸",
  "sweden": "🇸🇪",
  "suecia": "🇸🇪",
  "switzerland": "🇨🇭",
  "suiza": "🇨🇭",
  "united states": "🇺🇸",
  "usa": "🇺🇸",
  "uruguay": "🇺🇾"
});


function overlayCss() {
  return `
    :host {
      all: initial;
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .eei-canvas-mount,
    .eei-ui-layer {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      pointer-events: none;
    }

    .eei-ui-layer {
      z-index: ${MAX_Z_INDEX};
    }

    .eei-eyebrow {
      margin: 0;
      font-size: 10px;
      line-height: 1;
      letter-spacing: 0;
      text-transform: uppercase;
      color: rgba(15, 23, 42, 0.62);
      font-weight: 800;
    }

    .eei-maintenance {
      position: absolute;
      top: max(12px, env(safe-area-inset-top));
      left: 50%;
      transform: translateX(-50%);
      width: min(920px, calc(100vw - 28px));
      min-height: 62px;
      display: grid;
      grid-template-columns: 48px minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 9px 12px 9px 10px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.88);
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18);
      -webkit-backdrop-filter: blur(18px);
      backdrop-filter: blur(18px);
      color: #101827;
      pointer-events: none;
      animation: eei-slide-down 420ms cubic-bezier(.2,.8,.2,1) both;
    }

    .eei-maintenance img {
      width: 48px;
      height: 48px;
      object-fit: contain;
    }

    .eei-maintenance-copy {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    .eei-maintenance-copy strong {
      font-size: 15px;
      line-height: 1.2;
      color: #0f172a;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .eei-maintenance-copy span {
      font-size: 12px;
      line-height: 1.35;
      color: rgba(15, 23, 42, 0.66);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .eei-countdown {
      min-width: 102px;
      border-left: 1px solid rgba(15, 23, 42, 0.1);
      padding-left: 14px;
      text-align: right;
    }

    .eei-countdown span {
      display: block;
      font-size: 18px;
      line-height: 1.1;
      font-weight: 850;
      color: #0f172a;
      white-space: nowrap;
    }

    .eei-countdown small {
      display: block;
      margin-top: 4px;
      font-size: 10px;
      color: rgba(15, 23, 42, 0.56);
      text-transform: uppercase;
      letter-spacing: 0;
      font-weight: 800;
      white-space: nowrap;
    }

    .eei-toast {
      position: absolute;
      right: max(18px, env(safe-area-inset-right));
      bottom: max(22px, env(safe-area-inset-bottom));
      width: min(430px, calc(100vw - 32px));
      display: grid;
      grid-template-columns: 96px minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      padding: 14px 16px 14px 12px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.22);
      -webkit-backdrop-filter: blur(20px);
      backdrop-filter: blur(20px);
      color: #0f172a;
      pointer-events: none;
      animation: eei-toast-in 460ms cubic-bezier(.2,.8,.2,1) both;
    }

    .eei-toast.is-leaving {
      animation: eei-toast-out 360ms cubic-bezier(.4,0,.2,1) forwards;
    }

    .eei-toast img {
      width: 96px;
      height: 96px;
      object-fit: contain;
      align-self: end;
    }

    .eei-toast h2 {
      margin: 5px 0 5px;
      font-size: 18px;
      line-height: 1.12;
      color: #0f172a;
      letter-spacing: 0;
    }

    .eei-toast-message {
      margin: 0 0 8px;
      color: rgba(15, 23, 42, 0.68);
      font-size: 13px;
      line-height: 1.35;
    }

    .eei-toast ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 7px;
    }

    .eei-toast li {
      display: grid;
      gap: 2px;
      font-size: 12px;
      color: rgba(15, 23, 42, 0.58);
    }

    .eei-toast li strong {
      font-size: 13px;
      color: #0f172a;
    }

    .eei-birthday-plantel-card {
      position: fixed;
      right: max(12px, env(safe-area-inset-right));
      bottom: max(12px, env(safe-area-inset-bottom));
      z-index: 4;
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.86);
      border: 1px solid rgba(20, 32, 31, 0.12);
      box-shadow: 0 18px 44px rgba(20, 32, 31, 0.14);
      backdrop-filter: blur(18px);
      animation: eei-soft-rise 280ms ease both;
    }

    .eei-birthday-plantel-open,
    .eei-birthday-plantel-dismiss {
      pointer-events: auto;
      border: 0;
      cursor: pointer;
      font: inherit;
    }

    .eei-birthday-plantel-open {
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px 4px 4px;
      border-radius: 999px;
      background: transparent;
      color: #14312c;
      font-size: 12px;
      font-weight: 900;
    }

    .eei-birthday-plantel-open img {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      object-fit: cover;
      display: block;
    }

    .eei-birthday-plantel-dismiss {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: rgba(20, 32, 31, 0.06);
      color: rgba(20, 32, 31, 0.7);
      font-size: 18px;
      line-height: 1;
      font-weight: 900;
    }

    .eei-birthday-plantel-modal {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: end center;
      padding: 18px;
      background: rgba(15, 23, 42, 0.16);
      pointer-events: auto;
    }

    .eei-birthday-plantel-dialog {
      position: relative;
      width: min(420px, calc(100vw - 28px));
      max-height: min(560px, calc(100vh - 36px));
      overflow: auto;
      padding: 18px;
      border-radius: 12px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 28px 90px rgba(15, 23, 42, 0.28);
      color: #0f172a;
      -webkit-backdrop-filter: blur(22px);
      backdrop-filter: blur(22px);
    }

    .eei-modal-close {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.08);
      color: #0f172a;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }

    .eei-birthday-plantel-dialog h2 {
      margin: 0 36px 6px 0;
      font-size: 20px;
      line-height: 1.15;
      color: #0f172a;
    }

    .eei-birthday-plantel-dialog p {
      margin: 0 0 14px;
      font-size: 13px;
      line-height: 1.4;
      color: rgba(15, 23, 42, 0.7);
    }

    .eei-birthday-plantel-list {
      display: grid;
      gap: 8px;
      margin: 0 0 16px;
    }

    .eei-birthday-plantel-list label {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 11px;
      border-radius: 9px;
      background: rgba(15, 23, 42, 0.055);
      font-size: 14px;
      line-height: 1.25;
      color: #0f172a;
      cursor: pointer;
    }

    .eei-birthday-plantel-list input {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
    }

    .eei-birthday-plantel-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .eei-birthday-plantel-actions button {
      min-height: 34px;
      border: 0;
      border-radius: 999px;
      padding: 0 14px;
      background: rgba(15, 23, 42, 0.08);
      color: #0f172a;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
    }

    .eei-birthday-plantel-actions [data-action="save"] {
      background: #0f172a;
      color: white;
    }


    .eei-birthday-plantel-card {
      right: max(10px, env(safe-area-inset-right));
      bottom: max(10px, env(safe-area-inset-bottom));
      gap: 2px;
      padding: 3px;
      background: rgba(255, 255, 255, 0.76);
      border: 1px solid rgba(9, 45, 42, 0.1);
      box-shadow: 0 14px 34px rgba(9, 45, 42, 0.12);
      opacity: 0.92;
      transform: translateZ(0);
    }

    .eei-birthday-plantel-card:hover,
    .eei-birthday-plantel-card:focus-within {
      opacity: 1;
    }

    .eei-birthday-plantel-open {
      min-height: 34px;
      padding: 3px 9px 3px 3px;
      gap: 7px;
      color: #063f3a;
      font-size: 11px;
      letter-spacing: -0.01em;
    }

    .eei-birthday-plantel-glyph {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, rgba(9, 117, 109, 0.14), rgba(9, 117, 109, 0.08));
      color: #05756e;
    }

    .eei-birthday-plantel-label {
      display: inline-block;
      max-width: 70px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .eei-birthday-plantel-dismiss {
      width: 26px;
      height: 26px;
      background: rgba(9, 45, 42, 0.06);
      color: rgba(9, 45, 42, 0.56);
      font-size: 16px;
    }

    .eei-birthday-plantel-modal {
      background: rgba(8, 20, 18, 0.22);
      align-items: end;
      padding: 12px;
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
    }

    .eei-birthday-plantel-dialog {
      width: min(460px, calc(100vw - 24px));
      max-height: min(620px, calc(100vh - 28px));
      padding: 16px;
      border-radius: 24px;
      border-color: rgba(9, 45, 42, 0.1);
      color: #0f1b19;
      box-shadow: 0 28px 100px rgba(8, 20, 18, 0.24);
    }

    .eei-birthday-plantel-dialog h2 {
      margin: 2px 40px 6px 0;
      font-size: 22px;
      letter-spacing: -0.04em;
      color: #0f1b19;
    }

    .eei-birthday-plantel-dialog p {
      margin: 0 40px 14px 0;
      color: rgba(15, 27, 25, 0.66);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.35;
      letter-spacing: -0.01em;
    }

    .eei-birthday-plantel-search {
      width: 100%;
      min-height: 42px;
      border: 1px solid rgba(15, 27, 25, 0.12);
      border-radius: 16px;
      padding: 0 12px;
      margin: 0 0 12px;
      background: rgba(15, 27, 25, 0.045);
      color: #0f1b19;
      font: inherit;
      font-size: 14px;
      font-weight: 800;
      outline: none;
    }

    .eei-birthday-plantel-list {
      max-height: min(320px, 45vh);
      overflow: auto;
      padding-right: 2px;
    }

    .eei-birthday-plantel-list label {
      min-height: 46px;
      padding: 11px 12px;
      border-radius: 15px;
      background: rgba(15, 27, 25, 0.045);
      color: #0f1b19;
      font-size: 14px;
      font-weight: 800;
    }

    .eei-birthday-plantel-list input {
      accent-color: #05756e;
    }

    .eei-birthday-plantel-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-top: 12px;
    }

    .eei-birthday-plantel-actions button {
      min-height: 42px;
      border-radius: 15px;
      background: rgba(15, 27, 25, 0.06);
      color: #0f1b19;
      font-size: 13px;
      font-weight: 900;
    }

    .eei-birthday-plantel-actions [data-action="save"] {
      background: linear-gradient(135deg, #05756e, #064b46);
      color: #fff;
    }

    @media (max-width: 520px) {
      .eei-birthday-plantel-card {
        left: auto;
        right: max(10px, env(safe-area-inset-right));
        bottom: max(10px, env(safe-area-inset-bottom));
      }

      .eei-birthday-plantel-label {
        display: none;
      }

      .eei-birthday-plantel-open {
        padding-right: 3px;
      }

      .eei-birthday-plantel-dialog {
        width: calc(100vw - 20px);
        border-radius: 24px 24px 18px 18px;
      }
    }

    .eei-worldcup {
      position: absolute;
      left: max(12px, env(safe-area-inset-left));
      bottom: max(12px, env(safe-area-inset-bottom));
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: calc(100vw - 24px);
      min-height: 28px;
      padding: 4px 5px 4px 7px;
      border: 1px solid rgba(15, 23, 42, 0.1);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.76);
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
      -webkit-backdrop-filter: blur(14px);
      backdrop-filter: blur(14px);
      color: #0f172a;
      pointer-events: auto;
      animation: eei-pin-in 260ms cubic-bezier(.2,.8,.2,1) both;
    }

    .eei-worldcup-flags {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }

    .eei-worldcup-chip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 1px;
      height: 20px;
      min-width: 34px;
      padding: 0 4px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.055);
      font-size: 14px;
      line-height: 1;
      white-space: nowrap;
    }

    .eei-worldcup-hide {
      width: 18px;
      height: 18px;
      display: inline-grid;
      place-items: center;
      border: 0;
      border-radius: 999px;
      padding: 0;
      background: rgba(15, 23, 42, 0.08);
      color: rgba(15, 23, 42, 0.7);
      font-size: 14px;
      line-height: 1;
      font-weight: 800;
      cursor: pointer;
      pointer-events: auto;
    }

    .eei-worldcup-hide:hover,
    .eei-worldcup-hide:focus-visible {
      background: rgba(15, 23, 42, 0.16);
      color: #0f172a;
      outline: none;
    }

    @keyframes eei-pin-in {
      from { opacity: 0; transform: translateY(5px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes eei-toast-in {
      from { opacity: 0; transform: translateY(18px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes eei-toast-out {
      to { opacity: 0; transform: translateY(12px); }
    }
  `;
}

const api = {
  start: startEEI,
  update: updateEEI,
  destroy: destroyEEI,
  getInstance: getEEI,
  DEFAULT_CONFIG,
  version: EEI_VERSION
};

window.EEI = api;

const params = new URL(import.meta.url).searchParams;
if (params.get("autostart") === "1") {
  const endpoint = params.get("config") || window.__EEI_BOOT__?.configEndpoint || "/__eei/config";
  fetch(endpoint, {
    cache: "no-store",
    credentials: endpoint.startsWith("http") ? "omit" : "same-origin",
    headers: {
      Accept: "application/json"
    }
  })
    .then((response) => {
      if (!response.ok) throw new Error(`EEI config failed: ${response.status}`);
      return response.json();
    })
    .then((config) => startEEI(config, { configEndpoint: endpoint }))
    .catch((error) => {
      console.warn("EEI autostart skipped because config could not be loaded", error);
    });
}
