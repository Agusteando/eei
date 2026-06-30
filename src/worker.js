const CONFIG_KEY = "config";
const SIGNIA_DEFAULT_URL = "https://signia.casitaapps.com/api/export/employees/today-birthdays";

const DEFAULT_CONFIG = {
  version: 1,
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
    mockBirthdays: [
      {
        id: 123,
        name: "Nombre Apellido",
        puesto: "Docente",
        plantel: "Plantel Centro",
        cumpleanos: "06-30"
      }
    ]
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
      sportsApiUrl: "/__eei/mock-worldcup-matches",
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

    if (url.pathname === "/__eei/mock-worldcup-matches") {
      return handleMockWorldCupMatches(request);
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
    return deepMerge(DEFAULT_CONFIG, stored || {});
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

    const body = await upstream.text();
    return withCors(new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=120"
      }
    }));
  } catch (error) {
    return json({
      error: "Could not fetch Signia birthdays",
      detail: String(error && error.message ? error.message : error)
    }, {}, 502);
  }
}

function handleMockWorldCupMatches(request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") || todayInTimeZone("America/Mexico_City");
  const matches = [
    {
      id: `${date}-mexico-1`,
      date,
      time: "18:00",
      status: "scheduled",
      competition: "FIFA World Cup 2026",
      home: "Mexico",
      away: "Korea Republic",
      venue: "Estadio Azteca",
      city: "Ciudad de Mexico",
      priority: 1,
      source: "mock"
    },
    {
      id: `${date}-canada-1`,
      date,
      time: "15:00",
      status: "scheduled",
      competition: "FIFA World Cup 2026",
      home: "Canada",
      away: "Croatia",
      venue: "BC Place",
      city: "Vancouver",
      priority: 3,
      source: "mock"
    },
    {
      id: `${date}-usa-1`,
      date,
      time: "20:30",
      status: "scheduled",
      competition: "FIFA World Cup 2026",
      home: "United States",
      away: "Ghana",
      venue: "MetLife Stadium",
      city: "New York New Jersey",
      priority: 4,
      source: "mock"
    }
  ];

  return json({
    date,
    timezone: "America/Mexico_City",
    source: "mock",
    matches
  }, {
    "Cache-Control": "public, max-age=60"
  });
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

  const injection = [
    '<script>window.__EEI_BOOT__={configEndpoint:"/__eei/config"};</script>',
    '<script type="module" src="/__eei/engine.js?autostart=1&config=%2F__eei%2Fconfig"></script>'
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
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
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
