// A local stand-in for wss://stt-rt.soniox.com/transcribe-websocket that
// follows the documented protocol closely enough to test the app:
//  * auth with the protocols list ['soniox-api-key', KEY] (echoes the protocol)
//  * JSON config first, then binary audio, empty text frame = end of stream
//  * scripted tokens: non-final -> final originals, then translation, <end>
//  * error frames + close, like the real server
// Control endpoints (HTTP on the same port) let tests break things:
//   GET /control/drop    -> kill every connection abruptly (network loss)
//   GET /control/error?type=service_unavailable&code=503
//   GET /control/stats   -> JSON with what the server saw
//   GET /control/reset
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const HOMILY = [
  ['Drodzy bracia i siostry, dzisiejsza Ewangelia mówi nam o miłosierdziu Bożym.', 'Queridos hermanos y hermanas, el Evangelio de hoy nos habla de la misericordia de Dios.'],
  ['Pan Jezus przychodzi do każdego z nas, także dzisiaj.', 'El Señor Jesús viene a cada uno de nosotros, también hoy.'],
  ['Nie bójmy się otworzyć serca na Jego łaskę.', 'No tengamos miedo de abrir el corazón a su gracia.'],
];
const DIALOG = [
  ['pl', 'es', 'Dzień dobry, w czym mogę pomóc?', 'Buenos días, ¿en qué puedo ayudarle?'],
  ['es', 'pl', 'Quisiera dos panecillos y un café, por favor.', 'Poproszę dwie bułki i kawę.'],
  ['pl', 'es', 'Razem dwadzieścia złotych. Kartą czy gotówką?', 'En total veinte zlotys. ¿Con tarjeta o en efectivo?'],
  ['es', 'pl', 'Con tarjeta, gracias.', 'Kartą, dziękuję.'],
];

function tokenize(text) {
  // Word-ish tokens with leading spaces, long words split like sub-words.
  const out = [];
  for (const [i, w] of text.split(' ').entries()) {
    const word = (i ? ' ' : '') + w;
    if (w.length > 8) {
      const cut = Math.ceil(word.length / 2);
      out.push(word.slice(0, cut), word.slice(cut));
    } else out.push(word);
  }
  return out;
}

function* utterance(src, tgt, srcLang, tgtLang) {
  const O = (text, fin = true) => ({ text, is_final: fin, translation_status: 'original', language: srcLang, confidence: 0.97 });
  const T = (text, fin = true) => ({
    text,
    is_final: fin,
    translation_status: 'translation',
    language: tgtLang,
    source_language: srcLang,
  });
  const sw = tokenize(src);
  const tw = tokenize(tgt);
  for (let i = 0; i < sw.length; i++) {
    yield { final: i >= 2 ? [O(sw[i - 2])] : [], nonFinal: sw.slice(Math.max(0, i - 1), i + 1).map((t) => O(t, false)) };
  }
  yield { final: sw.slice(Math.max(0, sw.length - 2)).map((t) => O(t)), nonFinal: [] };
  for (let i = 0; i < tw.length; i++) {
    yield { final: i >= 1 ? [T(tw[i - 1])] : [], nonFinal: [T(tw[i], false)] };
  }
  yield { final: [T(tw[tw.length - 1])], nonFinal: [] };
  yield { final: [{ text: '<end>', is_final: true }], nonFinal: [] };
  for (let i = 0; i < 4; i++) yield { final: [], nonFinal: [] }; // a short pause
}

function* script(config) {
  const two = config.translation && config.translation.type === 'two_way';
  for (;;) {
    if (two) for (const [sl, tl, s, t] of DIALOG) yield* utterance(s, t, sl, tl);
    else for (const [s, t] of HOMILY) yield* utterance(s, t, 'pl', 'es');
  }
}

export function startMock(port = 8787, { tickMs = 110 } = {}) {
  const stats = { connections: 0, configs: [], keys: [], streams: [], endFrames: 0, finishedSent: 0, errorsSent: 0 };
  const live = new Set();
  let nextError = null;
  let hangHandshakes = 0; // simulate a stalled handshake on a weak network
  const hungSockets = new Set();

  const http = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/control/drop') {
      for (const c of live) c.ws.terminate();
      res.end(JSON.stringify({ dropped: live.size }));
    } else if (url.pathname === '/control/error') {
      nextError = { error_code: Number(url.searchParams.get('code') || 503), error_type: url.searchParams.get('type') || 'service_unavailable' };
      for (const c of live) c.fail(nextError);
      nextError = null;
      res.end('{"ok":true}');
    } else if (url.pathname === '/control/hang') {
      hangHandshakes = Number(url.searchParams.get('count') || 1);
      res.end('{"ok":true}');
    } else if (url.pathname === '/control/stats') {
      res.end(JSON.stringify({ ...stats, live: live.size }));
    } else if (url.pathname === '/control/reset') {
      Object.assign(stats, { connections: 0, configs: [], keys: [], streams: [], endFrames: 0, finishedSent: 0, errorsSent: 0 });
      res.end('{"ok":true}');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  const wss = new WebSocketServer({
    server: http,
    path: '/transcribe-websocket',
    handleProtocols: (protocols) => (protocols.has('soniox-api-key') ? 'soniox-api-key' : false),
    verifyClient: (info, cb) => {
      if (hangHandshakes > 0) {
        hangHandshakes -= 1;
        stats.hung = (stats.hung || 0) + 1;
        hungSockets.add(info.req.socket);
        return; // never answer: the client must time out on its own
      }
      cb(true);
    },
  });

  wss.on('connection', (ws, req) => {
    stats.connections += 1;
    const protos = (req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    let key = protos[0] === 'soniox-api-key' ? protos[1] : null;
    const stream = { key, firstChunkHex: null, bytes: 0, chunks: 0, ended: false, config: null };
    stats.streams.push(stream);
    let gen = null;
    let timer = null;
    let lastAudioAt = 0;
    let finalMs = 0;
    const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
    const conn = {
      ws,
      fail(err) {
        stats.errorsSent += 1;
        send({ tokens: [], final_audio_proc_ms: finalMs, total_audio_proc_ms: finalMs, ...err, error_message: 'mock ' + err.error_type });
        clearInterval(timer);
        ws.close(1000);
      },
    };
    live.add(conn);

    const authTimer = setTimeout(() => {
      if (!stream.config) conn.fail({ error_code: 401, error_type: 'unauthenticated' });
    }, 1500);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (text === '') {
          // End of stream: flush and finish.
          stats.endFrames += 1;
          stream.ended = true;
          clearInterval(timer);
          setTimeout(() => {
            send({ tokens: [], final_audio_proc_ms: finalMs, total_audio_proc_ms: finalMs, finished: true });
            stats.finishedSent += 1;
            ws.close(1000);
          }, 150);
          return;
        }
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return conn.fail({ error_code: 400, error_type: 'invalid_request' });
        }
        if (msg.type === 'keepalive') return;
        if (msg.type === 'finalize') return send({ tokens: [{ text: '<fin>', is_final: true }] });
        // Start request.
        clearTimeout(authTimer);
        if (!key && msg.api_key) key = msg.api_key;
        stream.key = key;
        stats.keys.push(key);
        if (!key || key === 'bad') return conn.fail({ error_code: 401, error_type: 'unauthenticated' });
        if (key === 'nobalance') return conn.fail({ error_code: 402, error_type: 'organization_balance_exhausted' });
        if (msg.model !== 'stt-rt-v6' || !msg.audio_format) return conn.fail({ error_code: 400, error_type: 'invalid_request' });
        stream.config = msg;
        stats.configs.push(msg);
        gen = script(msg);
        timer = setInterval(() => {
          if (Date.now() - lastAudioAt > 1500) return; // silence: nothing to say
          const ev = gen.next().value;
          finalMs += tickMs;
          send({ tokens: [...ev.final, ...ev.nonFinal], final_audio_proc_ms: finalMs, total_audio_proc_ms: finalMs + 300 });
        }, tickMs);
        return;
      }
      if (!stream.config) return;
      if (stream.chunks === 0) stream.firstChunkHex = Buffer.from(data).subarray(0, 4).toString('hex');
      stream.chunks += 1;
      stream.bytes += data.length;
      lastAudioAt = Date.now();
    });

    ws.on('close', () => {
      clearInterval(timer);
      clearTimeout(authTimer);
      live.delete(conn);
    });
  });

  return new Promise((ok) => http.listen(port, '127.0.0.1', () => ok({ http, wss, stats, close: () => new Promise((r) => { for (const c of live) c.ws.terminate(); for (const sock of hungSockets) sock.destroy(); wss.close(); http.closeAllConnections(); http.close(r); }) })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8787);
  startMock(port).then(() => console.log(`mock Soniox on ws://localhost:${port}/transcribe-websocket`));
}
