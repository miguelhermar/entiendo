// App-wide constants and the per-mode Soniox session configuration.

export const APP_VERSION = '1.0.0';
export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
export const SONIOX_MODEL = 'stt-rt-v6';
export const SONIOX_CONSOLE_URL = 'https://console.soniox.com/';
// Approximate price used only for the usage estimate shown in Settings.
export const SONIOX_USD_PER_HOUR = 0.15;

export const MODES = {
  misa: {
    id: 'misa',
    label: 'Misa',
    icon: 'church',
    twoWay: false,
    hint: 'Pon el teléfono hacia un altavoz de la iglesia y pulsa el micrófono. Verás la homilía en polaco y su traducción al español.',
    tip: 'Consejo: activa el modo silencio y baja el brillo.',
  },
  escuchar: {
    id: 'escuchar',
    label: 'Escuchar',
    icon: 'ear',
    twoWay: false,
    hint: 'Pulsa el micrófono y apunta el teléfono hacia quien habla en polaco. Funciona con guías, anuncios, radio o la calle.',
    tip: '',
  },
  conversar: {
    id: 'conversar',
    label: 'Conversar',
    icon: 'messages-square',
    twoWay: true,
    hint: 'Habla en español o deja que te hablen en polaco: la app detecta el idioma sola y traduce en ambas direcciones.',
    tip: 'Toca una de tus frases para mostrar el polaco en grande.',
  },
};

export const MODE_ORDER = ['misa', 'escuchar', 'conversar'];

// ---------------------------------------------------------------------------
// Soniox context (docs: /stt/concepts/context). Max 8,000 tokens; these are
// far smaller. Terms improve recognition; translation_terms pin translations.

const MASS_CONTEXT = {
  general: [
    { key: 'domain', value: 'Catholic Mass (Msza Święta) in a Polish church' },
    { key: 'topic', value: 'Liturgy, Bible readings, homily, prayers, parish announcements' },
    { key: 'speakers', value: 'Priest, lector, congregation' },
    { key: 'audio', value: 'Church with loudspeakers and reverberation' },
  ],
  text:
    'Msza Święta po polsku: obrzędy wstępne, akt pokuty, Chwała na wysokości Bogu, kolekta, ' +
    'liturgia słowa (pierwsze czytanie, psalm responsoryjny, drugie czytanie, aklamacja, Ewangelia), ' +
    'homilia, wyznanie wiary, modlitwa powszechna, przygotowanie darów, modlitwa eucharystyczna, ' +
    'Ojcze nasz, znak pokoju, Baranku Boży, Komunia Święta, ogłoszenia duszpasterskie, błogosławieństwo.\n' +
    'Zwroty: W imię Ojca i Syna, i Ducha Świętego. Pan z wami. I z duchem twoim. ' +
    'Spowiadam się Bogu wszechmogącemu i wam, bracia i siostry. Panie, zmiłuj się nad nami. Módlmy się. ' +
    'Oto słowo Boże. Bogu niech będą dzięki. Słowa Ewangelii według świętego Łukasza. Chwała Tobie, Panie. ' +
    'Oto słowo Pańskie. Chwała Tobie, Chryste. Wierzę w jednego Boga. W górę serca. Wznosimy je do Pana. ' +
    'Dzięki składajmy Panu Bogu naszemu. Godne to i sprawiedliwe. Oto wielka tajemnica wiary. ' +
    'Przekażcie sobie znak pokoju. Oto Baranek Boży, który gładzi grzechy świata. ' +
    'Panie, nie jestem godzien, abyś przyszedł do mnie. Idźcie w pokoju Chrystusa. ' +
    'Niech będzie pochwalony Jezus Chrystus. Na wieki wieków. Amen.\n' +
    'Homilia: drodzy bracia i siostry, umiłowani w Chrystusie Panu, dzisiejsza Ewangelia, Słowo Boże, ' +
    'Królestwo Boże, nawrócenie, modlitwa, wiara, nadzieja, miłość, grzech, łaska, zbawienie, krzyż, zmartwychwstanie.',
  terms: [
    'Msza Święta', 'homilia', 'kazanie', 'Ewangelia', 'Pismo Święte', 'Słowo Boże', 'Pan Jezus', 'Jezus Chrystus',
    'Duch Święty', 'Bóg Ojciec', 'Najświętsza Maryja Panna', 'Matka Boża', 'Bogurodzica', 'Eucharystia',
    'Najświętszy Sakrament', 'Komunia Święta', 'sakrament pokuty', 'spowiedź', 'rozgrzeszenie', 'błogosławieństwo',
    'Ojciec Święty', 'papież Leon XIV', 'Jan Paweł II', 'święta Faustyna', 'Miłosierdzie Boże', 'biskup', 'proboszcz',
    'wikariusz', 'ksiądz', 'diakon', 'parafia', 'rekolekcje', 'Adwent', 'Wielki Post', 'Triduum Paschalne',
    'Wielkanoc', 'Boże Narodzenie', 'Pasterka', 'Zesłanie Ducha Świętego', 'Wniebowzięcie', 'Różaniec',
    'Koronka do Miłosierdzia Bożego', 'Droga Krzyżowa', 'Gorzkie Żale', 'Apel Jasnogórski', 'Jasna Góra',
    'Częstochowa', 'Łagiewniki', 'apostoł', 'faryzeusze', 'uczniowie', 'Królestwo Boże', 'zmartwychwstanie',
    'Alleluja', 'psalm responsoryjny', 'modlitwa wiernych', 'taca', 'ofiara', 'intencja', 'nowenna',
  ],
  translation_terms: [
    { source: 'Msza Święta', target: 'Santa Misa' },
    { source: 'homilia', target: 'homilía' },
    { source: 'kazanie', target: 'sermón' },
    { source: 'Słowo Boże', target: 'Palabra de Dios' },
    { source: 'Pismo Święte', target: 'Sagrada Escritura' },
    { source: 'Pan Jezus', target: 'el Señor Jesús' },
    { source: 'Duch Święty', target: 'Espíritu Santo' },
    { source: 'Najświętsza Maryja Panna', target: 'Santísima Virgen María' },
    { source: 'Matka Boża', target: 'Madre de Dios' },
    { source: 'Najświętszy Sakrament', target: 'Santísimo Sacramento' },
    { source: 'Komunia Święta', target: 'Sagrada Comunión' },
    { source: 'Eucharystia', target: 'Eucaristía' },
    { source: 'Ojciec Święty', target: 'Santo Padre' },
    { source: 'Jan Paweł II', target: 'Juan Pablo II' },
    { source: 'proboszcz', target: 'párroco' },
    { source: 'rekolekcje', target: 'retiro espiritual' },
    { source: 'Wielki Post', target: 'Cuaresma' },
    { source: 'Adwent', target: 'Adviento' },
    { source: 'Wielkanoc', target: 'Pascua' },
    { source: 'Boże Narodzenie', target: 'Navidad' },
    { source: 'Pasterka', target: 'Misa de Gallo' },
    { source: 'Zesłanie Ducha Świętego', target: 'Pentecostés' },
    { source: 'Wniebowzięcie', target: 'Asunción' },
    { source: 'Różaniec', target: 'Rosario' },
    { source: 'Droga Krzyżowa', target: 'Vía Crucis' },
    { source: 'Koronka do Miłosierdzia Bożego', target: 'Coronilla de la Divina Misericordia' },
    { source: 'Miłosierdzie Boże', target: 'Divina Misericordia' },
    { source: 'Królestwo Boże', target: 'Reino de Dios' },
    { source: 'bracia i siostry', target: 'hermanos y hermanas' },
    { source: 'psalm responsoryjny', target: 'salmo responsorial' },
    { source: 'modlitwa wiernych', target: 'oración de los fieles' },
    { source: 'ogłoszenia duszpasterskie', target: 'avisos parroquiales' },
    { source: 'Ojcze nasz', target: 'Padre Nuestro' },
    { source: 'Zdrowaś Maryjo', target: 'Ave María' },
    { source: 'Baranku Boży', target: 'Cordero de Dios' },
    { source: 'taca', target: 'colecta' },
    { source: 'Jasna Góra', target: 'Jasna Góra' },
  ],
};

const LISTEN_CONTEXT = {
  general: [
    { key: 'domain', value: 'Everyday spoken Polish heard by a Spanish-speaking visitor' },
    { key: 'setting', value: 'Poland: streets, shops, guided tours, announcements, transport, radio' },
  ],
  terms: [
    'Kraków', 'Warszawa', 'Wrocław', 'Gdańsk', 'Poznań', 'Łódź', 'Katowice', 'Lublin', 'Zakopane', 'Wieliczka',
    'Wawel', 'Rynek Główny', 'Sukiennice', 'Kazimierz', 'Stare Miasto', 'PKP', 'MPK', 'złotych', 'BLIK',
  ],
  translation_terms: [
    { source: 'złotych', target: 'zlotys' },
    { source: 'złoty', target: 'zloty' },
    { source: 'Rynek Główny', target: 'Plaza del Mercado' },
    { source: 'Stare Miasto', target: 'Casco Antiguo' },
  ],
};

const CONVERSATION_CONTEXT = {
  general: [
    { key: 'domain', value: 'Face-to-face conversation between a Spanish-speaking visitor and Polish locals' },
    { key: 'topics', value: 'shopping, prices, payment, food, directions, transport, church, small talk' },
  ],
  terms: [
    'złotych', 'grosze', 'paragon', 'reklamówka', 'BLIK', 'gotówka', 'kartą', 'Żabka', 'Biedronka', 'Lidl',
    'Rossmann', 'apteka', 'kantor', 'przystanek', 'tramwaj', 'bilet', 'pierogi', 'żurek', 'bigos', 'pączek',
    'obwarzanek', 'kiełbasa', 'proszę', 'dziękuję', 'przepraszam',
  ],
  translation_terms: [
    { source: 'złotych', target: 'zlotys' },
    { source: 'złoty', target: 'zloty' },
    { source: 'paragon', target: 'ticket' },
    { source: 'reklamówka', target: 'bolsa' },
    { source: 'kantor', target: 'casa de cambio' },
    { source: 'BLIK', target: 'BLIK' },
    { source: 'zlotys', target: 'złotych' },
    { source: 'ticket', target: 'paragon' },
  ],
};

// Build the Soniox start message for a mode (no api_key: the key is sent
// with the connection, see soniox.js).
export function buildSonioxConfig(modeId, { audio } = {}) {
  const base = {
    model: SONIOX_MODEL,
    enable_language_identification: true,
    enable_endpoint_detection: true,
    client_reference_id: 'entiendo-' + modeId,
  };
  if (audio && audio.format === 'pcm') {
    base.audio_format = 'pcm_s16le';
    base.sample_rate = audio.sampleRate || 16000;
    base.num_channels = 1;
  } else {
    base.audio_format = 'auto';
  }
  if (modeId === 'conversar') {
    return {
      ...base,
      language_hints: ['pl', 'es'],
      endpoint_sensitivity: 0.2,
      endpoint_latency_adjustment_level: 1,
      max_endpoint_delay_ms: 1500,
      translation: { type: 'two_way', language_a: 'pl', language_b: 'es' },
      context: CONVERSATION_CONTEXT,
    };
  }
  if (modeId === 'misa') {
    return {
      ...base,
      language_hints: ['pl'],
      // Wait a little longer before closing a sentence: homilies have
      // rhetorical pauses, and longer segments translate better.
      endpoint_sensitivity: -0.3,
      max_endpoint_delay_ms: 3000,
      translation: { type: 'one_way', target_language: 'es' },
      context: MASS_CONTEXT,
    };
  }
  return {
    ...base,
    language_hints: ['pl'],
    max_endpoint_delay_ms: 2000,
    translation: { type: 'one_way', target_language: 'es' },
    context: LISTEN_CONTEXT,
  };
}

// Which language a block should be translated into (used for fallback
// translations of text the engine left untranslated).
export function targetLangFor(block) {
  if (block.srcLang === 'es') return block.m === 'conversar' ? 'pl' : null;
  return 'es';
}

export const LANG_LABEL = {
  pl: 'PL', es: 'ES', en: 'EN', de: 'DE', uk: 'UK', ru: 'RU', it: 'IT', fr: 'FR', la: 'LA', cs: 'CS', sk: 'SK',
};

export const LANG_NAME = {
  pl: 'polaco', es: 'español', en: 'inglés', de: 'alemán', uk: 'ucraniano', ru: 'ruso', it: 'italiano',
  fr: 'francés', la: 'latín', cs: 'checo', sk: 'eslovaco', pt: 'portugués',
};
