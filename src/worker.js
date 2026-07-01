const CONFIG_KEY = "config";
const EEI_ASSET_VERSION = "2026-07-01-v2";
const SIGNIA_DEFAULT_URL = "https://signia.casitaapps.com/api/export/employees/today-birthdays";
const FOOTBALL_DATA_DEFAULT_BASE_URL = "https://api.football-data.org/v4";
const FOOTBALL_DATA_DEFAULT_COMPETITION = "WC";
const FOOTBALL_DATA_DEFAULT_SEASON = "2026";

const DEFAULT_CONFIG = {
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
    timezone: "America/Mexico_City",
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/__eei/")) {
      return withCors(new Response(null, { status: 204 }));
    }

    if (url.pathname === "/__eei/config") {
      return handleConfig(request, env);
    }

    if (url.pathname === "/__eei/signia-birthdays") {
      return handleSigniaBirthdays(env);
    }

    if (url.pathname === "/__eei/worldcup-matches") {
      return handleWorldCupMatches(request, env);
    }

    if (url.pathname === "/__eei/engine.js") {
      return serveAsset(env, request, "/eei-engine.js", "application/javascript; charset=utf-8");
    }

    if (url.pathname.startsWith("/__eei/vendor/")) {
      return serveAsset(env, request, url.pathname.replace("/__eei", ""), "application/javascript; charset=utf-8");
    }

    if (url.pathname.startsWith("/__eei/assets/")) {
      return serveAsset(env, request, url.pathname.replace("/__eei", ""));
    }

    if (url.pathname === "/eei-admin.html" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vendor/") || url.pathname === "/eei-engine.js") {
      return serveAsset(env, request, url.pathname);
    }

    const upstreamResponse = await fetchUpstream(request, env);
    return maybeInject(request, env, upstreamResponse);
  }
};

async function handleConfig(request, env) {
  if (request.method === "GET") {
    const config = await readConfig(env);
    return json(config, {
      "Cache-Control": "no-store"
    });
  }

  if (request.method !== "PUT" && request.method !== "POST" && request.method !== "PATCH") {
    return json({ error: "Method not allowed" }, {}, 405);
  }

  const auth = await requireAdmin(request, env);
  if (!auth.ok) {
    return json({ error: auth.error }, {}, auth.status);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, {}, 400);
  }

  const current = await readConfig(env);
  const next = request.method === "PATCH" ? deepMerge(current, payload) : deepMerge(DEFAULT_CONFIG, payload);

  if (!env.EEI_CONFIG) {
    return json({ error: "EEI_CONFIG KV binding is not available" }, {}, 500);
  }

  await env.EEI_CONFIG.put(CONFIG_KEY, JSON.stringify(next, null, 2), {
    metadata: {
      updatedAt: new Date().toISOString()
    }
  });

  return json(next, {
    "Cache-Control": "no-store"
  });
}

async function readConfig(env) {
  if (!env.EEI_CONFIG) {
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const stored = await env.EEI_CONFIG.get(CONFIG_KEY, { type: "json" });
    return normalizeRuntimeConfig(deepMerge(DEFAULT_CONFIG, stored || {}));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

async function requireAdmin(request, env) {
  const token = env.EEI_ADMIN_TOKEN;
  const url = new URL(request.url);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

  if (!token && isLocal) {
    return { ok: true };
  }

  if (!token) {
    return { ok: false, status: 403, error: "EEI_ADMIN_TOKEN is not configured" };
  }

  const header = request.headers.get("Authorization") || "";
  if (header === `Bearer ${token}`) {
    return { ok: true };
  }

  return { ok: false, status: 401, error: "Missing or invalid admin token" };
}

async function handleSigniaBirthdays(env) {
  const endpoint = env.SIGNIA_BIRTHDAY_URL || SIGNIA_DEFAULT_URL;
  const timezone = "America/Mexico_City";
  try {
    const upstream = await fetch(endpoint, {
      headers: {
        Accept: "application/json"
      },
      cf: {
        cacheTtl: 120,
        cacheEverything: true
      }
    });

    if (!upstream.ok) {
      return json({
        date: todayInTimeZone(timezone),
        timezone,
        count: 0,
        birthdays: [],
        error: "Could not fetch Signia birthdays",
        providerStatus: upstream.status
      }, {
        "Cache-Control": "no-store"
      }, 502);
    }

    const payload = await upstream.json().catch(() => null);
    const normalized = normalizeBirthdayPayload(payload, timezone);
    return json(normalized, {
      "Cache-Control": "public, max-age=120"
    });
  } catch (error) {
    return json({
      date: todayInTimeZone(timezone),
      timezone,
      count: 0,
      birthdays: [],
      error: "Could not fetch Signia birthdays",
      detail: String(error && error.message ? error.message : error)
    }, {}, 502);
  }
}

async function handleWorldCupMatches(request, env) {
  const token = env.FOOTBALL_DATA_API_TOKEN;
  const timezone = "America/Mexico_City";
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || todayInTimeZone(timezone);
  const dateFrom = url.searchParams.get("dateFrom") || date;
  const dateTo = url.searchParams.get("dateTo") || date;

  if (!token) {
    return json({
      date,
      dateFrom,
      dateTo,
      timezone,
      source: "football-data.org",
      count: 0,
      matches: [],
      error: "FOOTBALL_DATA_API_TOKEN is not configured"
    }, {
      "Cache-Control": "no-store"
    }, 503);
  }

  const baseUrl = env.FOOTBALL_DATA_BASE_URL || FOOTBALL_DATA_DEFAULT_BASE_URL;
  const competition = env.FOOTBALL_DATA_COMPETITION_CODE || FOOTBALL_DATA_DEFAULT_COMPETITION;
  const season = url.searchParams.get("season") || env.FOOTBALL_DATA_SEASON || FOOTBALL_DATA_DEFAULT_SEASON;
  const upstreamUrl = new URL(`${baseUrl.replace(/\/$/, "")}/competitions/${encodeURIComponent(competition)}/matches`);
  upstreamUrl.searchParams.set("dateFrom", dateFrom);
  upstreamUrl.searchParams.set("dateTo", dateTo);
  if (season) {
    upstreamUrl.searchParams.set("season", season);
  }

  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: "application/json",
        "X-Auth-Token": token
      },
      cf: {
        cacheTtl: 300,
        cacheEverything: true
      }
    });

    const payload = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      return json({
        date,
        dateFrom,
        dateTo,
        timezone,
        source: "football-data.org",
        count: 0,
        matches: [],
        error: "Could not fetch World Cup matches",
        providerStatus: upstream.status,
        detail: payload && (payload.message || payload.error)
      }, {
        "Cache-Control": "no-store"
      }, 502);
    }

    const matches = normalizeFootballDataMatches(Array.isArray(payload?.matches) ? payload.matches : [], timezone);
    return json({
      date,
      dateFrom,
      dateTo,
      timezone,
      source: "football-data.org",
      competition,
      season,
      count: matches.length,
      matches
    }, {
      "Cache-Control": "public, max-age=300"
    });
  } catch (error) {
    return json({
      date,
      dateFrom,
      dateTo,
      timezone,
      source: "football-data.org",
      count: 0,
      matches: [],
      error: "Could not fetch World Cup matches",
      detail: String(error && error.message ? error.message : error)
    }, {}, 502);
  }
}

async function fetchUpstream(request, env) {
  if (!env.UPSTREAM_ORIGIN) {
    return fetch(request);
  }

  const original = new URL(request.url);
  const upstream = new URL(env.UPSTREAM_ORIGIN);
  upstream.pathname = original.pathname;
  upstream.search = original.search;

  const proxyRequest = new Request(upstream.toString(), request);
  proxyRequest.headers.set("Host", upstream.host);
  return fetch(proxyRequest);
}

async function maybeInject(request, env, response) {
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("text/html")) {
    return response;
  }

  const config = await readConfig(env);
  if (!config.enabled || !routeAllowed(request, config)) {
    return response;
  }

  const engineUrl = `/__eei/engine.js?v=${encodeURIComponent(EEI_ASSET_VERSION)}&autostart=1&config=%2F__eei%2Fconfig`;
  const injection = [
    '<script>window.__EEI_BOOT__={configEndpoint:"/__eei/config"};</script>',
    `<script type="module" src="${engineUrl}"></script>`
  ].join("");

  const rewritten = new HTMLRewriter()
    .on("body", new BodyInjector(injection))
    .transform(response);

  const headers = new Headers(rewritten.headers);
  headers.delete("Content-Length");
  headers.set("X-EEI-Injected", "1");

  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers
  });
}

function routeAllowed(request, config) {
  const url = new URL(request.url);
  const path = url.pathname;
  const injection = config.injection || {};

  if (Array.isArray(injection.excludePaths) && injection.excludePaths.some((prefix) => path.startsWith(prefix))) {
    return false;
  }

  if (Array.isArray(injection.includePaths) && injection.includePaths.length > 0) {
    return injection.includePaths.some((prefix) => path.startsWith(prefix));
  }

  return true;
}

class BodyInjector {
  constructor(markup) {
    this.markup = markup;
  }

  element(element) {
    element.append(this.markup, { html: true });
  }
}

async function serveAsset(env, request, pathname, contentType) {
  if (!env.ASSETS) {
    return new Response("ASSETS binding is not available", { status: 500 });
  }

  const url = new URL(request.url);
  url.pathname = pathname;
  const response = await env.ASSETS.fetch(new Request(url, request));

  if (!contentType || response.status >= 400) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", contentType);
  if (pathname === "/eei-engine.js") {
    headers.set("Cache-Control", "no-cache");
  } else {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function json(value, headers = {}, status = 200) {
  return withCors(new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  }));
}

function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET,PUT,POST,PATCH,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
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


function normalizeRuntimeConfig(config) {
  const output = structuredClone(config);
  if (output?.festivities?.mundial_2026) {
    const current = String(output.festivities.mundial_2026.sportsApiUrl || "");
    if (!current || current.includes("mock-worldcup-matches")) {
      output.festivities.mundial_2026.sportsApiUrl = "/__eei/worldcup-matches";
    }
  }
  if (output?.birthday && !Array.isArray(output.birthday.mockBirthdays)) {
    output.birthday.mockBirthdays = [];
  }
  return output;
}

function normalizeBirthdayPayload(payload, timeZone) {
  const date = todayInTimeZone(timeZone);
  const sourceList = findFirstArray(payload, ["birthdays", "cumpleanos", "cumpleaneros", "employees", "data", "results", "items"]);
  const rawList = Array.isArray(payload) ? payload : sourceList || [];
  const birthdays = rawList
    .filter(Boolean)
    .filter((person) => birthdayEntryMatchesToday(person, date))
    .map(normalizeBirthdayPerson);

  return {
    date,
    timezone: timeZone,
    count: birthdays.length,
    birthdays
  };
}

function findFirstArray(payload, keys) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  for (const key of keys) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return null;
}

function normalizeBirthdayPerson(person) {
  return {
    id: person.id || person.employeeId || person.numeroEmpleado || person.email || person.name || person.nombre || crypto.randomUUID(),
    name: person.name || person.nombre || person.fullName || person.nombreCompleto || "Colaborador",
    puesto: person.puesto || person.position || person.cargo || person.title || "",
    plantel: person.plantel || person.campus || person.school || person.sede || "",
    cumpleanos: person.cumpleanos || person.birthday || person.birthdate || person.fechaNacimiento || ""
  };
}

function birthdayEntryMatchesToday(person, today) {
  const value = person.cumpleanos || person.birthday || person.birthdate || person.fechaNacimiento || person.date || "";
  if (!value) {
    return true;
  }

  const normalized = String(value).trim();
  const monthDay = today.slice(5);
  if (/^\d{2}-\d{2}$/.test(normalized)) {
    return normalized === monthDay;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(normalized)) {
    return normalized.slice(5, 10) === monthDay;
  }
  if (/^\d{2}\/\d{2}(?:\/\d{4})?$/.test(normalized)) {
    const [first, second] = normalized.split("/");
    return `${first.padStart(2, "0")}-${second.padStart(2, "0")}` === monthDay;
  }
  return true;
}

function normalizeFootballDataMatches(matches, timeZone) {
  return matches.map((match) => {
    const home = match.homeTeam || {};
    const away = match.awayTeam || {};
    const score = match.score || {};
    const fullTime = score.fullTime || {};
    const penalties = score.penalties || {};
    return {
      id: String(match.id || match.utcDate || `${home.name || "home"}-${away.name || "away"}`),
      date: match.utcDate ? formatDateInTimeZone(match.utcDate, timeZone) : "",
      time: match.utcDate ? formatTimeInTimeZone(match.utcDate, timeZone) : "TBD",
      utcDate: match.utcDate || "",
      status: normalizeFootballStatus(match.status),
      stage: match.stage || "",
      group: match.group || "",
      competition: match.competition?.name || "FIFA World Cup",
      home: home.shortName || home.tla || home.name || "Home",
      away: away.shortName || away.tla || away.name || "Away",
      venue: match.venue || "World Cup 2026",
      city: "",
      score: {
        home: fullTime.home ?? null,
        away: fullTime.away ?? null,
        penaltiesHome: penalties.home ?? null,
        penaltiesAway: penalties.away ?? null
      },
      source: "football-data.org"
    };
  });
}

function normalizeFootballStatus(status) {
  const normalized = String(status || "").toUpperCase();
  if (["SCHEDULED", "TIMED"].includes(normalized)) {
    return "scheduled";
  }
  if (["IN_PLAY", "PAUSED", "EXTRA_TIME", "PENALTY_SHOOTOUT"].includes(normalized)) {
    return "live";
  }
  if (normalized === "FINISHED") {
    return "finished";
  }
  return normalized.toLowerCase() || "scheduled";
}

function formatDateInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function formatTimeInTimeZone(value, timeZone) {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.hour}:${byType.minute}`;
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
