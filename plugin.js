// Podcasts en español (v0.1.0).
// Catálogo: rankings y búsqueda públicos de Apple Podcasts (itunes.apple.com).
// Episodios: el RSS público de cada podcast, que es lo que publica su propio creador.

const APPLE = "https://itunes.apple.com";
const SEIS_HORAS = 6 * 60 * 60 * 1000;
const POR_PAGINA = 100;
const MAX_EPISODIOS = 1000;

// Temas que se ven en Inicio. "apple" son los números de género de Apple Podcasts:
// 1489 Noticias, 1487 Historia, 1488 Crimen real, 1303 Comedia, 1309 TV y cine,
// 1318 Tecnología, 1533 Ciencia.
const TEMAS = [
  { id: "noticias", titulo: "Noticias y actualidad", genre: "noticias", apple: [1489] },
  { id: "historia", titulo: "Historia y misterio", genre: "documentales", apple: [1487, 1488] },
  { id: "comedia", titulo: "Comedia y entretenimiento", genre: "entretenimiento", apple: [1303, 1309] },
  { id: "tecnologia", titulo: "Tecnología y ciencia", genre: "otros", apple: [1318, 1533] },
];

// Países cuyos rankings se mezclan. Latinoamérica pesa más: España entra con la mitad de sus podcasts.
const PAISES_INICIO = ["mx", "co", "ar"];
const PAISES_VER_MAS = ["bo", "mx", "co", "ar", "cl", "pe", "es"];
const MEDIO_PESO = ["es"];
const PAISES_BUSQUEDA = ["MX", "AR", "CO", "ES"];

// ---------- Utilidades ----------

// Ejecuta las tareas de a pocas a la vez (Kino permite 6 peticiones en vuelo).
async function enLotes(tareas, tamano) {
  const salida = [];
  for (let i = 0; i < tareas.length; i += tamano) {
    const lote = tareas.slice(i, i + tamano).map((t) => t());
    const resultados = await Promise.all(lote);
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
  if (p.artista) item.overview = String(p.artista).slice(0, 300);
  return item;
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

// Los podcasts de un tema, mezclando los rankings de varios países.
async function podcastsDelTema(tema, paises, cuantos) {
  const tareas = [];
  const claves = [];
  for (const pais of paises) {
    for (const genero of tema.apple) {
      claves.push(pais);
      tareas.push(() => pedirRanking(pais, genero, cuantos));
    }
  }
  const resultados = await enLotes(tareas, 6);
  const porPais = paises.map((pais) => intercalar(resultados.filter((_, i) => claves[i] === pais)));
  const medias = new Set();
  paises.forEach((pais, i) => {
    if (MEDIO_PESO.includes(pais)) medias.add(i);
  });
  return sinRepetir(intercalar(porPais, medias));
}

// Guarda el resultado de cada tema unas horas para no repetir las mismas peticiones.
async function temaConMemoria(tema, clave, paises, cuantos) {
  const guardado = kino.storage.get(clave);
  if (typeof guardado === "string") {
    try {
      const filas = JSON.parse(guardado);
      if (Array.isArray(filas) && filas.length) {
        return filas.map((f) => ({ id: f[0], nombre: f[1], img: f[2], artista: f[3] }));
      }
    } catch (e) {
      kino.log("La memoria de " + clave + " no se pudo leer: " + e);
    }
  }
  const lista = await podcastsDelTema(tema, paises, cuantos);
  if (lista.length) {
    kino.storage.set(clave, JSON.stringify(lista.map((p) => [p.id, p.nombre, p.img, p.artista])), { ttlMs: SEIS_HORAS });
  }
  return lista;
}

// ---------- XML del RSS ----------

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

// ---------- Lo que Kino llama ----------

export async function home() {
  await null;
  const filas = [];
  for (const tema of TEMAS) {
    const lista = await temaConMemoria(tema, "inicio-" + tema.id, PAISES_INICIO, 20);
    if (!lista.length) continue;
    filas.push({
      id: tema.id,
      title: tema.titulo,
      genre: tema.genre,
      ref: tema.id,
      items: lista.slice(0, 40).map(aItem),
    });
  }
  if (!filas.length) throw kino.error("unavailable", "no pude leer los rankings de Apple");
  return filas;
}

export async function browse(ref, cursor) {
  await null;
  const tema = TEMAS.find((t) => t.id === ref);
  if (!tema) throw kino.error("not_found");
  const lista = await temaConMemoria(tema, "vermas-" + tema.id, PAISES_VER_MAS, 50);
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

  // Apple da la dirección del RSS del podcast.
  const busqueda = await kino.fetch(APPLE + "/lookup?entity=podcast&id=" + id, {
    headers: { Accept: "application/json" },
    timeoutMs: 8000,
  });
  if (!busqueda.ok) throw kino.error("unavailable", "Apple respondió " + busqueda.status);
  const ficha = ((busqueda.json() || {}).results || [])[0];
  const feedUrl = ficha && ficha.feedUrl ? String(ficha.feedUrl).replace(/^http:/i, "https:") : "";
  if (!feedUrl) throw kino.error("not_found", "el podcast no publica su RSS");

  let respuesta;
  try {
    respuesta = await kino.fetch(feedUrl, {
      headers: { Accept: "application/rss+xml, application/xml, text/xml, */*", "User-Agent": "Kino-Podcasts/0.1" },
      timeoutMs: 15000,
    });
  } catch (e) {
    const codigo = e && e.code ? e.code : "";
    kino.log("No pude abrir el RSS: " + codigo);
    throw kino.error("unavailable", codigo === "too_large" ? "el RSS pesa demasiado" : "no pude abrir el RSS (" + codigo + ")");
  }
  if (!respuesta.ok) throw kino.error("unavailable", "el RSS respondió " + respuesta.status);

  const { serie, episodios } = leerFeed(respuesta.text());
  if (!episodios.length) throw kino.error("not_found", "el RSS no trae episodios");

  // Los feeds suelen venir con el más nuevo primero; el numerado va del más viejo al más nuevo.
  const primero = episodios[0].fecha;
  const ultimo = episodios[episodios.length - 1].fecha;
  const masNuevoPrimero = !(primero && ultimo && primero < ultimo);
  const ordenados = masNuevoPrimero ? episodios.slice().reverse() : episodios;
  const recortados = ordenados.slice(-MAX_EPISODIOS);

  const info = {
    title: serie.title || (ficha && ficha.collectionName) || undefined,
    overview: serie.overview || undefined,
    poster: serie.poster || (ficha && ficha.artworkUrl600) || undefined,
  };
  return {
    series: info,
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
