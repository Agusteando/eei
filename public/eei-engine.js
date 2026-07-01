import * as THREE from "./vendor/three.module.js";

const EEI_VERSION = "0.2.0";
const MAX_Z_INDEX = "2147483647";
const DEFAULT_TIMEZONE = "America/Mexico_City";

export const DEFAULT_CONFIG = {
  version: 2,
  enabled: true,
  assetsBaseUrl: "auto",
  performance: {
    maxPixelRatio: 1.5,
    pauseWhenHidden: true
  },
  maintenance: {
    enabled: true,
    title: "Mantenimiento programado",
    message: "La plataforma entrara en una ventana breve de servicio.",
    targetAt: "2026-07-01T03:00:00-06:00",
    severity: "planned"
  },
  birthday: {
    enabled: true,
    mode: "api",
    apiUrl: "/__eei/signia-birthdays",
    timezone: DEFAULT_TIMEZONE,
    showOncePerDay: true,
    toastDurationMs: 9500,
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
      intensity: 0.75
    },
    mundial_2026: {
      enabled: false,
      intensity: 0.72,
      sportsApiUrl: "/__eei/worldcup-matches",
      priorityTeam: "Mexico"
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
    let widget = this.uiLayer.querySelector("[data-eei-widget='worldcup']");
    if (!widget) {
      widget = document.createElement("aside");
      widget.className = "eei-worldcup";
      widget.dataset.eeiWidget = "worldcup";
      this.uiLayer.appendChild(widget);
    }

    const priorityTeam = (config.priorityTeam || "Mexico").toLowerCase();
    const sorted = [...(matches || [])].sort((a, b) => {
      const aPriority = [a.home, a.away].some((team) => String(team).toLowerCase().includes(priorityTeam)) ? 0 : 1;
      const bPriority = [b.home, b.away].some((team) => String(team).toLowerCase().includes(priorityTeam)) ? 0 : 1;
      return aPriority - bPriority || String(a.time || "").localeCompare(String(b.time || ""));
    }).slice(0, 3);

    const rows = sorted.map((match) => `
      <li>
        <span class="eei-match-time">${escapeHtml(match.time || "TBD")}</span>
        <strong>${escapeHtml(match.home || "Home")} vs ${escapeHtml(match.away || "Away")}</strong>
        <span>${escapeHtml(match.venue || match.city || "World Cup 2026")}</span>
      </li>
    `).join("");

    widget.innerHTML = `
      <p class="eei-eyebrow">Mundial 2026</p>
      <h2>Partidos de hoy</h2>
      <ul>${rows || "<li><strong>Sin partidos publicados</strong><span>Esperando calendario</span></li>"}</ul>
    `;
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

    const birthdays = Array.isArray(data.birthdays) ? data.birthdays : [];
    if (birthdays.length === 0) {
      return;
    }

    const date = data.date || todayInTimeZone(config.timezone || DEFAULT_TIMEZONE);
    if (!options.forceBirthday && config.showOncePerDay && this.hasShown(date)) {
      return;
    }

    this.markShown(date);
    this.release(birthdays);
    this.engine.showToast("birthday", {
      eyebrow: "Cumpleanos de hoy",
      title: birthdays.length === 1 ? "Celebremos a nuestro equipo" : "Celebremos a nuestro equipo",
      message: birthdays.length === 1 ? "Hoy celebramos una historia que suma a la comunidad." : `Hoy celebramos ${birthdays.length} historias dentro de la comunidad.`,
      people: birthdays,
      image: this.engine.assetUrl("ambassadors", "birthday"),
      durationMs: config.toastDurationMs || 9500
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
    this.engine.showToast("winter", {
      eyebrow: "Temporada",
      title: "Ambiente de invierno",
      message: "La experiencia visual de temporada esta activa.",
      image: this.engine.assetUrl("ambassadors", "winter"),
      durationMs: 5200
    });
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
    this.group.name = "EEI Fireworks";
    this.engine.scene.add(this.group);
    this.sparkMap = this.engine.getParticleAtlasTile(2);
    this.timer = 0;
    this.engine.showToast("new-year", {
      eyebrow: "Celebracion",
      title: "Nuevo ciclo en marcha",
      message: "La capa de fuegos artificiales esta activa.",
      image: this.engine.assetUrl("ambassadors", "newYear"),
      durationMs: 5200
    });
  }

  spawnBurst() {
    const count = Math.round(90 + 90 * Number(this.config.intensity || 0.75));
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
      size: 18,
      vertexColors: true,
      map: this.sparkMap,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    const points = new THREE.Points(geometry, material);
    this.group.add(points);
    this.bursts.push({ points, positions, velocities, age: 0, life: randomBetween(1.35, 2.2) });
  }

  update(dt) {
    if (!this.active) {
      return;
    }

    this.timer -= dt;
    if (this.timer <= 0) {
      this.spawnBurst();
      this.timer = randomBetween(0.55, 1.2);
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
      roughness: 0.42,
      metalness: 0.03
    });

    const count = Math.round(3 + 4 * Number(this.config.intensity || 0.72));
    for (let index = 0; index < count; index += 1) {
      const radius = randomBetween(34, 54);
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.scale.setScalar(radius);
      mesh.position.set(
        randomBetween(-this.engine.size.width / 2 + radius, this.engine.size.width / 2 - radius),
        randomBetween(-this.engine.size.height / 2 + radius, this.engine.size.height / 3),
        randomBetween(-60, 240)
      );
      mesh.userData.radius = radius;
      mesh.userData.velocity = new THREE.Vector2(randomBetween(-130, 130), randomBetween(170, 360));
      mesh.userData.spin = new THREE.Vector3(randomBetween(-2, 2), randomBetween(-3, 3), randomBetween(-1, 1));
      this.balls.push(mesh);
      this.group.add(mesh);
    }

    this.loadMatches();
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

  update(dt) {
    if (!this.active) {
      return;
    }

    const gravity = -620;
    const width = this.engine.size.width;
    const height = this.engine.size.height;

    for (const ball of this.balls) {
      const velocity = ball.userData.velocity;
      const radius = ball.userData.radius;
      velocity.y += gravity * dt;
      ball.position.x += velocity.x * dt;
      ball.position.y += velocity.y * dt;

      const left = -width / 2 + radius;
      const right = width / 2 - radius;
      const bottom = -height / 2 + radius + 10;
      const top = height / 2 - radius;

      if (ball.position.x < left || ball.position.x > right) {
        ball.position.x = clamp(ball.position.x, left, right);
        velocity.x *= -0.86;
      }

      if (ball.position.y < bottom) {
        ball.position.y = bottom;
        velocity.y = Math.abs(velocity.y) * randomBetween(0.72, 0.88);
        velocity.x += randomBetween(-42, 42);
      } else if (ball.position.y > top) {
        ball.position.y = top;
        velocity.y *= -0.42;
      }

      ball.rotation.x += ball.userData.spin.x * dt + velocity.y * dt * 0.005;
      ball.rotation.y += ball.userData.spin.y * dt + velocity.x * dt * 0.005;
      ball.rotation.z += ball.userData.spin.z * dt;
    }
  }

  stop() {
    if (!this.active) {
      return;
    }

    this.active = false;
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

    .eei-toast h2,
    .eei-worldcup h2 {
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

    .eei-toast ul,
    .eei-worldcup ul {
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

    .eei-worldcup {
      position: absolute;
      left: max(18px, env(safe-area-inset-left));
      bottom: max(22px, env(safe-area-inset-bottom));
      width: min(360px, calc(100vw - 32px));
      padding: 16px;
      border: 1px solid rgba(15, 23, 42, 0.12);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.9);
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.2);
      -webkit-backdrop-filter: blur(20px);
      backdrop-filter: blur(20px);
      color: #0f172a;
      animation: eei-toast-in 420ms cubic-bezier(.2,.8,.2,1) both;
    }

    .eei-worldcup li {
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr);
      gap: 4px 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(15, 23, 42, 0.09);
      font-size: 12px;
      color: rgba(15, 23, 42, 0.58);
    }

    .eei-worldcup li strong {
      color: #0f172a;
      font-size: 13px;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .eei-worldcup li span:last-child {
      grid-column: 2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .eei-match-time {
      grid-row: span 2;
      align-self: start;
      display: inline-flex;
      min-height: 28px;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      border-radius: 999px;
      background: #103f3b;
      color: #f8fafc;
      font-size: 11px;
      font-weight: 850;
      white-space: nowrap;
    }

    @media (max-width: 640px) {
      .eei-maintenance {
        grid-template-columns: 38px minmax(0, 1fr);
        align-items: start;
      }

      .eei-maintenance img {
        width: 38px;
        height: 38px;
      }

      .eei-countdown {
        grid-column: 1 / -1;
        width: 100%;
        min-width: 0;
        border-left: 0;
        border-top: 1px solid rgba(15, 23, 42, 0.1);
        padding: 8px 0 0;
        display: flex;
        justify-content: space-between;
        align-items: center;
        text-align: left;
      }

      .eei-toast {
        grid-template-columns: 74px minmax(0, 1fr);
      }

      .eei-toast img {
        width: 74px;
        height: 74px;
      }

      .eei-worldcup {
        bottom: 150px;
      }
    }

    @keyframes eei-slide-down {
      from { opacity: 0; transform: translate(-50%, -16px); }
      to { opacity: 1; transform: translate(-50%, 0); }
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
    credentials: "same-origin",
    headers: {
      Accept: "application/json"
    }
  })
    .then((response) => response.ok ? response.json() : DEFAULT_CONFIG)
    .catch(() => DEFAULT_CONFIG)
    .then((config) => startEEI(config, { configEndpoint: endpoint }));
}
