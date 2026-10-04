// Podcasts en español (v0.2.0).
// Catálogo: rankings y búsqueda públicos de Apple Podcasts (itunes.apple.com).
// Episodios: primero la lista de Apple (rápida y sin límite de tamaño); si no hay, el RSS del propio podcast.
// Solo se muestran programas activos: con un episodio nuevo en los últimos DIAS_ACTIVO días.

const APPLE = "https://itunes.apple.com";
const SEIS_HORAS = 6 * 60 * 60 * 1000;
const DIEZ_MINUTOS = 10 * 60 * 1000;
const POR_PAGINA = 100;
const MAX_EPISODIOS = 1000;
const DIAS_ACTIVO = 120;

// Temas que aparecen como bloques en Categorías. "apple" es el número de género de Apple Podcasts.
const TEMAS = [
  { id: "noticias", titulo: "Noticias y actualidad", genre: "noticias", apple: 1489 },
  { id: "politica", titulo: "Política", genre: "noticias", apple: 1527 },
  { id: "historia", titulo: "Historia", genre: "documentales", apple: 1487 },
  { id: "misterio", titulo: "Misterio y crimen real", genre: "documentales", apple: 1488 },
  { id: "ciencia", titulo: "Ciencia", genre: "documentales", apple: 1533 },
  { id: "comedia", titulo: "Comedia", genre: "entretenimiento", apple: 1303 },
  { id: "cine", titulo: "Cine y TV", genre: "entretenimiento", apple: 1309 },
  { id: "sociedad", titulo: "Sociedad y cultura", genre: "entretenimiento", apple: 1324 },
  { id: "tecnologia", titulo: "Tecnología", genre: "otros", apple: 1318 },
];
const RECIENTES = { id: "recientes", titulo: "Más recientes", genre: "entretenimiento" };

// Países cuyos rankings se mezclan. Latinoamérica pesa más: España entra con la mitad de sus podcasts.
const PAISES_INICIO = ["mx", "co", "ar"];
const PAISES_VER_MAS = ["bo", "mx", "co", "ar", "cl", "pe", "es"];
const MEDIO_PESO = ["es"];
const PAISES_BUSQUEDA = ["MX", "AR", "CO", "ES"];

// Memoria de corta vida mientras el plugin sigue abierto (los datos más pesados no van al almacenamiento).
const memoria = {};

function deMemoria(clave) {
  const m = memoria[clave];
  return m && Date.now() - m.hora < DIEZ_MINUTOS ? m.datos : null;
}

function aMemoria(clave, datos) {
  memoria[clave] = { hora: Date.now(), datos };
}

// ---------- Utilidades ----------

// Ejecuta las tareas de a pocas a la vez (Kino permite 6 peticiones en vuelo).
async function enLotes(tareas, tamano) {
  const salida = [];
  for (let i = 0; i < tareas.length; i += tamano) {
    const resultados = await Promise.all(tareas.slice(i, i + tamano).map((t) => t()));
    for (const r of resultados) salida.push(r);
  }
  return salida;
}

// Mezcla listas turnándose: el primero de cada una, luego el segundo de cada una...
// Las listas de "medias" solo aportan en las rondas pares (la mitad de sus elementos).
function intercalar(listas, medias) {
  const salida = [];
  let max = 0;
  for (const l of listas) if (l.length > max) max = l.length;
  for (let i = 0; i < max; i++) {
    for (let j = 0; j < listas.length; j++) {
      if (medias && medias.has(j) && i % 2 === 1) continue;
      if (i < listas[j].length) salida.push(listas[j][i]);
    }
  }
  return salida;
}

function sinRepetir(podcasts) {
  const vistos = new Set();
  const salida = [];
  for (const p of podcasts) {
    if (vistos.has(p.id)) continue;
    vistos.add(p.id);
    salida.push(p);
  }
  return salida;
}

function aItem(p) {
  const item = { id: "p" + p.id, ref: p.id, title: p.nombre.slice(0, 200), kind: "series" };
  if (/^https?:\/\//i.test(p.img || "")) item.poster = p.img;
  const partes = [];
  if (p.fecha) partes.push("Último episodio: " + p.fecha);
  if (p.artista) partes.push(p.artista);
  if (partes.length) item.overview = partes.join(" · ").slice(0, 300);
  return item;
}

function corteDeActividad() {
  return new Date(Date.now() - DIAS_ACTIVO * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Un programa sin fecha conocida se deja pasar: sin datos no se puede decir que esté abandonado.
function esActivo(fecha) {
  return !fecha || fecha >= corteDeActividad();
}

function porFechaDesc(a, b) {
  if (a.fecha === b.fecha) return 0;
  if (!a.fecha) return 1;
  if (!b.fecha) return -1;
  return a.fecha < b.fecha ? 1 : -1;
}

// ---------- Rankings de Apple ----------

function leerRanking(json) {
  let entradas = json && json.feed && json.feed.entry;
  if (!entradas) return [];
  if (!Array.isArray(entradas)) entradas = [entradas];
  const lista = [];
  for (const e of entradas) {
    const id = e && e.id && e.id.attributes && e.id.attributes["im:id"];
    const nombre = e && e["im:name"] && e["im:name"].label;
    const imagenes = e && e["im:image"];
    const img = Array.isArray(imagenes) && imagenes.length ? imagenes[imagenes.length - 1].label : "";
    const artista = e && e["im:artist"] && e["im:artist"].label;
    if (/^\d+$/.test(String(id || "")) && nombre) {
      lista.push({ id: String(id), nombre: String(nombre), img: String(img || ""), artista: String(artista || "") });
    }
  }
  return lista;
}

// Un ranking de un país y un género. Si falla, devuelve una lista vacía y el resto sigue.
async function pedirRanking(pais, genero, cuantos) {
  try {
    const r = await kino.fetch(
      APPLE + "/" + pais + "/rss/toppodcasts/limit=" + cuantos + "/genre=" + genero + "/json",
      { headers: { Accept: "application/json" }, timeoutMs: 8000 }
    );
    if (!r.ok) {
      kino.log("Ranking " + pais + "/" + genero + " respondió " + r.status);
      return [];
    }
    return leerRanking(r.json());
  } catch (e) {
    kino.log("Ranking " + pais + "/" + genero + " falló: " + (e && e.code ? e.code : e));
    return [];
  }
}

function mezclarPaises(listasPorPais, paises) {
  const medias = new Set();
  paises.forEach((pais, i) => {
    if (MEDIO_PESO.includes(pais)) medias.add(i);
  });
  return sinRepetir(intercalar(listasPorPais, medias));
}

// Lo que se guarda en el almacenamiento es poco: 30 programas por tema.
function leerGuardado(clave) {
  const g = kino.storage.get(clave);
  if (typeof g !== "string") return null;
  try {
    const filas = JSON.parse(g);
    if (!Array.isArray(filas) || !filas.length) return null;
    return filas.map((f) => ({ id: f[0], nombre: f[1], img: f[2], artista: f[3] }));
  } catch (e) {
    kino.log("No pude leer " + clave + ": " + e);
    return null;
  }
}

function escribirGuardado(clave, lista) {
  const filas = lista.slice(0, 30).map((p) => [p.id, p.nombre, p.img, p.artista]);
  kino.storage.set(clave, JSON.stringify(filas), { ttlMs: SEIS_HORAS });
}

// Los rankings de varios temas a la vez, de a 6 peticiones. Si se acaba el tiempo, los temas que
// faltan se omiten y se completan en la próxima vez (lo ya leído queda guardado).
async function cargarTemas(temas, paises, cuantos, prefijo, limiteMs) {
  const resultado = {};
  const pendientes = [];
  for (const tema of temas) {
    const guardado = leerGuardado(prefijo + tema.id);
    if (guardado) resultado[tema.id] = guardado;
    else pendientes.push(tema);
  }
  const tareas = [];
  for (const tema of pendientes) for (const pais of paises) tareas.push({ tema, pais });
  const leidos = {};
  const inicio = Date.now();
  for (let i = 0; i < tareas.length; i += 6) {
    if (Date.now() - inicio > limiteMs) break;
    const lote = tareas.slice(i, i + 6);
    const listas = await Promise.all(lote.map((t) => pedirRanking(t.pais, t.tema.apple, cuantos)));
    lote.forEach((t, j) => {
      if (!leidos[t.tema.id]) leidos[t.tema.id] = {};
      leidos[t.tema.id][t.pais] = listas[j];
    });
  }
  for (const tema of pendientes) {
    const porPais = leidos[tema.id];
    if (!porPais) continue;
    const completo = paises.every((p) => porPais[p]);
    const lista = mezclarPaises(paises.map((p) => porPais[p] || []), paises);
    resultado[tema.id] = lista;
    if (completo && lista.length) escribirGuardado(prefijo + tema.id, lista);
  }
  return resultado;
}

// ---------- Actividad: cuándo salió el último episodio de cada programa ----------

async function pedirFichas(ids) {
  try {
    const r = await kino.fetch(APPLE + "/lookup?entity=podcast&id=" + ids.join(","), {
      headers: { Accept: "application/json" },
      timeoutMs: 8000,
    });
    if (!r.ok) return null;
    const datos = r.json();
    return (datos && datos.results) || [];
  } catch (e) {
    kino.log("Falló la consulta de actividad: " + (e && e.code ? e.code : e));
    return null;
  }
}

// Devuelve { idDelPodcast: "AAAA-MM-DD" } con la fecha de su último episodio ("" si no se supo).
async function actividad(ids) {
  let mapa = {};
  const guardado = kino.storage.get("actividad");
  if (typeof guardado === "string") {
    try {
      mapa = JSON.parse(guardado) || {};
    } catch (e) {
      mapa = {};
    }
  }
  const faltan = ids.filter((id) => !(id in mapa));
  if (!faltan.length) return mapa;
  const lotes = [];
  for (let i = 0; i < faltan.length; i += 150) lotes.push(faltan.slice(i, i + 150));
  const respuestas = await enLotes(lotes.map((l) => () => pedirFichas(l)), 6);
  let aprendio = false;
  respuestas.forEach((fichas, k) => {
    if (fichas === null) return; // falló: se vuelve a intentar la próxima vez
    aprendio = true;
    for (const f of fichas) {
      if (f && f.collectionId) mapa[String(f.collectionId)] = String(f.releaseDate || "").slice(0, 10);
    }
    for (const id of lotes[k]) if (!(id in mapa)) mapa[id] = "";
  });
  if (aprendio) {
    if (Object.keys(mapa).length > 1200) {
      const reducido = {};
      for (const id of ids) if (id in mapa) reducido[id] = mapa[id];
      mapa = reducido;
    }
    kino.storage.set("actividad", JSON.stringify(mapa), { ttlMs: SEIS_HORAS });
  }
  return mapa;
}

// Marca cada programa con la fecha de su último episodio y deja solo los activos.
async function soloActivos(lista) {
  const mapa = await actividad(lista.map((p) => p.id));
  const salida = [];
  for (const p of lista) {
    const fecha = mapa[p.id] || "";
    if (esActivo(fecha)) salida.push(Object.assign({}, p, { fecha }));
  }
  return salida;
}

// Todos los programas activos de todos los temas, del episodio más nuevo al más viejo.
async function listaDeRecientes() {
  const porTema = await cargarTemas(TEMAS, PAISES_INICIO, 20, "i-", 10000);
  const todos = [];
  for (const tema of TEMAS) for (const p of porTema[tema.id] || []) todos.push(p);
  const activos = await soloActivos(sinRepetir(todos));
  return { porTema, activos, recientes: activos.filter((p) => p.fecha).sort(porFechaDesc) };
}

// ---------- XML del RSS (solo como respaldo) ----------

function decodificar(texto) {
  return texto
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Texto limpio: sin CDATA, sin etiquetas HTML y con las entidades resueltas.
function limpiar(texto) {
  const sinCdata = String(texto).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodificar(sinCdata.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function textoDe(xml, etiqueta) {
  const m = new RegExp("<" + etiqueta + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + etiqueta + ">", "i").exec(xml);
  return m ? limpiar(m[1]) : "";
}

function atributoDe(xml, etiqueta, atributo) {
  const m = new RegExp("<" + etiqueta + "\\b[^>]*?\\b" + atributo + "\\s*=\\s*[\"']([^\"']+)[\"']", "i").exec(xml);
  return m ? decodificar(m[1]).trim() : "";
}

const MESES = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

function fechaDe(pubDate) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(pubDate || "");
  if (!m || !MESES[m[2].toLowerCase()]) return "";
  return m[3] + "-" + MESES[m[2].toLowerCase()] + "-" + m[1].padStart(2, "0");
}

function minutosDe(duracion) {
  const d = String(duracion || "").trim();
  if (!d) return 0;
  let segundos = 0;
  if (d.includes(":")) {
    for (const parte of d.split(":")) segundos = segundos * 60 + (Number(parte) || 0);
  } else {
    segundos = Number(d) || 0;
  }
  return segundos >= 30 ? Math.max(1, Math.round(segundos / 60)) : 0;
}

function leerFeed(xml) {
  const partes = xml.split(/<item[\s>]/i);
  const cabecera = partes[0];
  const serie = {
    title: textoDe(cabecera.replace(/<image>[\s\S]*?<\/image>/i, ""), "title"),
    overview: textoDe(cabecera, "description").slice(0, 600),
    poster: atributoDe(cabecera, "itunes:image", "href") || "",
  };
  const episodios = [];
  for (const parte of partes.slice(1)) {
    const cuerpo = parte.split(/<\/item>/i)[0];
    const url = atributoDe(cuerpo, "enclosure", "url");
    if (!/^https?:\/\//i.test(url) || url.length > 3000) continue;
    const imagen = atributoDe(cuerpo, "itunes:image", "href");
    episodios.push({
      url,
      titulo: textoDe(cuerpo, "title").slice(0, 200) || "Episodio",
      fecha: fechaDe(textoDe(cuerpo, "pubDate")),
      minutos: minutosDe(textoDe(cuerpo, "itunes:duration")),
      resumen: textoDe(cuerpo, "description").slice(0, 300),
      imagen: /^https?:\/\//i.test(imagen) ? imagen : "",
    });
  }
  return { serie, episodios };
}

// ---------- Episodios ----------

// Los 200 episodios más nuevos según Apple: no depende del servidor del podcast ni del tamaño de su RSS.
async function episodiosDeApple(id) {
  const r = await kino.fetch(APPLE + "/lookup?entity=podcastEpisode&limit=200&id=" + id, {
    headers: { Accept: "application/json" },
    timeoutMs: 10000,
  });
  if (!r.ok) throw kino.error("unavailable", "Apple respondió " + r.status);
  const resultados = ((r.json() || {}).results) || [];
  const ficha = resultados.find((x) => x && x.kind === "podcast") || null;
  const episodios = [];
  for (const x of resultados) {
    const esEpisodio = x && (x.kind === "podcast-episode" || x.wrapperType === "podcastEpisode");
    const url = String((x && x.episodeUrl) || "").replace(/^http:/i, "https:");
    if (!esEpisodio || !/^https:\/\//i.test(url) || url.length > 3000) continue;
    const imagen = String(x.artworkUrl600 || x.artworkUrl160 || "");
    episodios.push({
      url,
      titulo: limpiar(x.trackName || "").slice(0, 200) || "Episodio",
      fecha: String(x.releaseDate || "").slice(0, 10),
      minutos: x.trackTimeMillis ? Math.max(1, Math.round(Number(x.trackTimeMillis) / 60000)) : 0,
      resumen: limpiar(x.description || x.shortDescription || "").slice(0, 300),
      imagen: /^https?:\/\//i.test(imagen) ? imagen : "",
    });
  }
  return {
    serie: {
      title: ficha && ficha.collectionName ? String(ficha.collectionName) : "",
      overview: "",
      poster: ficha && ficha.artworkUrl600 ? String(ficha.artworkUrl600) : "",
    },
    episodios,
    feedUrl: ficha && ficha.feedUrl ? String(ficha.feedUrl).replace(/^http:/i, "https:") : "",
  };
}

// Respaldo: el RSS del propio podcast (puede pedir permiso para un servidor nuevo).
async function episodiosDelFeed(feedUrl) {
  let respuesta;
  try {
    respuesta = await kino.fetch(feedUrl, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml, */*", "User-Agent": "Kino-Podcasts/0.2" },
      timeoutMs: 15000,
    });
  } catch (e) {
    const codigo = e && e.code ? e.code : "";
    kino.log("No pude abrir el RSS: " + codigo);
    throw kino.error("unavailable", codigo === "too_large" ? "el RSS pesa demasiado" : "no pude abrir el RSS (" + codigo + ")");
  }
  if (!respuesta.ok) throw kino.error("unavailable", "el RSS respondió " + respuesta.status);
  return leerFeed(respuesta.text());
}

// ---------- Lo que Kino llama ----------

export async function home() {
  await null;
  const modo = kino.config.get("inicio") === "temas" ? "temas" : "reciente";
  const { porTema, activos, recientes } = await listaDeRecientes();
  if (!recientes.length && !activos.length) throw kino.error("unavailable", "no pude leer los rankings de Apple");
  const base = recientes.length ? recientes : activos;
  const filas = [
    {
      id: RECIENTES.id,
      title: RECIENTES.titulo,
      genre: RECIENTES.genre,
      ref: RECIENTES.id,
      items: base.slice(0, 40).map(aItem),
    },
  ];
  if (modo === "temas") {
    const fechas = {};
    for (const p of activos) fechas[p.id] = p.fecha;
    for (const tema of TEMAS) {
      const lista = (porTema[tema.id] || []).filter((p) => p.id in fechas).map((p) => Object.assign({}, p, { fecha: fechas[p.id] }));
      if (lista.length < 3) continue;
      filas.push({ id: tema.id, title: tema.titulo, genre: tema.genre, ref: tema.id, items: lista.slice(0, 30).map(aItem) });
    }
  }
  return filas;
}

export async function browse(ref, cursor) {
  await null;
  let lista;
  if (ref === RECIENTES.id) {
    const { activos, recientes } = await listaDeRecientes();
    lista = recientes.length ? recientes : activos;
  } else {
    const tema = TEMAS.find((t) => t.id === ref);
    if (!tema) throw kino.error("not_found");
    lista = deMemoria("ver-" + tema.id);
    if (!lista) {
      const rankings = await enLotes(PAISES_VER_MAS.map((pais) => () => pedirRanking(pais, tema.apple, 50)), 6);
      lista = await soloActivos(mezclarPaises(rankings, PAISES_VER_MAS));
      if (lista.length) aMemoria("ver-" + tema.id, lista);
    }
  }
  const desde = Math.max(0, Number(cursor) || 0);
  const resultado = { items: lista.slice(desde, desde + POR_PAGINA).map(aItem) };
  if (desde + POR_PAGINA < lista.length) resultado.next = String(desde + POR_PAGINA);
  return resultado;
}

export async function search(query) {
  await null;
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const tareas = PAISES_BUSQUEDA.map((pais) => async () => {
    try {
      const r = await kino.fetch(
        APPLE + "/search?media=podcast&entity=podcast&limit=25&country=" + pais + "&term=" + encodeURIComponent(q),
        { headers: { Accept: "application/json" }, timeoutMs: 8000 }
      );
      if (!r.ok) return [];
      const datos = r.json();
      return ((datos && datos.results) || [])
        .filter((x) => x && x.collectionId && x.collectionName)
        .map((x) => ({
          id: String(x.collectionId),
          nombre: String(x.collectionName),
          img: String(x.artworkUrl600 || x.artworkUrl100 || ""),
          artista: String(x.artistName || ""),
          fecha: String(x.releaseDate || "").slice(0, 10),
        }));
    } catch (e) {
      kino.log("Búsqueda en " + pais + " falló: " + (e && e.code ? e.code : e));
      return [];
    }
  });
  const resultados = await enLotes(tareas, 6);
  return sinRepetir(intercalar(resultados)).slice(0, 100).map(aItem);
}

export async function episodes(ref) {
  await null;
  const id = String(ref || "");
  if (!/^\d+$/.test(id)) throw kino.error("not_found");

  let datos = await episodiosDeApple(id);
  if (!datos.episodios.length) {
    if (!datos.feedUrl) throw kino.error("not_found", "el podcast no tiene episodios");
    const delFeed = await episodiosDelFeed(datos.feedUrl);
    datos = {
      serie: {
        title: delFeed.serie.title || datos.serie.title,
        overview: delFeed.serie.overview,
        poster: delFeed.serie.poster || datos.serie.poster,
      },
      episodios: delFeed.episodios,
      feedUrl: datos.feedUrl,
    };
  }
  if (!datos.episodios.length) throw kino.error("not_found", "no hay episodios para reproducir");

  // Casi siempre vienen con el más nuevo primero; el numerado va del más viejo al más nuevo.
  const primero = datos.episodios[0].fecha;
  const ultimo = datos.episodios[datos.episodios.length - 1].fecha;
  const masNuevoPrimero = !(primero && ultimo && primero < ultimo);
  const ordenados = masNuevoPrimero ? datos.episodios.slice().reverse() : datos.episodios;
  const recortados = ordenados.slice(-MAX_EPISODIOS);

  const series = {};
  if (datos.serie.title) series.title = datos.serie.title;
  if (datos.serie.overview) series.overview = datos.serie.overview;
  if (datos.serie.poster) series.poster = datos.serie.poster;
  return {
    series,
    episodes: recortados.map((e, i) => {
      const episodio = { season: 1, number: i + 1, ref: "e:" + e.url, title: e.titulo };
      if (e.fecha) episodio.airDate = e.fecha;
      if (e.minutos) episodio.runtimeMinutes = e.minutos;
      if (e.resumen) episodio.overview = e.resumen;
      if (e.imagen) episodio.still = e.imagen;
      return episodio;
    }),
  };
}

// El episodio ya trae su dirección de audio (o de video, si el podcast lo publica así).
export async function resolve(ref) {
  await null;
  const texto = String(ref || "");
  const url = texto.startsWith("e:") ? texto.slice(2) : "";
  if (!/^https?:\/\//i.test(url)) throw kino.error("not_found");
  return { url };
}
