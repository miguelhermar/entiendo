import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../app/js/transcript.js';
import { SonioxSegmenter, joinText, SOFT_MAX } from '../app/js/segmenter.js';

// Helpers to build Soniox-like tokens.
const o = (text, lang = 'pl', fin = true) => ({ text, is_final: fin, translation_status: 'original', language: lang });
const t = (text, lang = 'es', src = 'pl', fin = true) => ({
  text,
  is_final: fin,
  translation_status: 'translation',
  language: lang,
  source_language: src,
});
const n = (text, lang = 'es', fin = true) => ({ text, is_final: fin, translation_status: 'none', language: lang });
const END = { text: '<end>', is_final: true };
const nf = (tk) => ({ ...tk, is_final: false });

function setup(opts) {
  const tr = new Transcript();
  const seg = new SonioxSegmenter(tr, opts);
  return { tr, seg };
}

test('joinText spacing rules', () => {
  assert.equal(joinText('', ' Hola'), 'Hola');
  assert.equal(joinText('Hola', ' mundo', false), 'Hola mundo');
  assert.equal(joinText('Hola,', 'mundo', true), 'Hola, mundo');
  assert.equal(joinText('Hola', ',', true), 'Hola,');
  assert.equal(joinText('Hola ', 'mundo', true), 'Hola mundo');
  assert.equal(joinText('Ewan', 'gelia', false), 'Ewangelia');
});

test('one-way: provisional text, then final text and its translation', () => {
  const { tr, seg } = setup({ twoWay: false, mode: 'misa' });

  seg.ingest([nf(o('Bracia')), nf(o(' i')), nf(o(' siostry'))]);
  assert.equal(tr.blocks.length, 0);
  assert.equal(tr.pvExtra.length, 1);
  assert.equal(tr.pvExtra[0].src, 'Bracia i siostry');

  seg.ingest([o('Bracia'), o(' i'), o(' siostry'), o(','), nf(o(' dzisiaj'))]);
  assert.equal(tr.blocks.length, 1);
  assert.equal(tr.blocks[0].src, 'Bracia i siostry,');
  assert.equal(tr.blocks[0].m, 'misa');
  assert.deepEqual(tr.pvMods.get(1), { srcNF: ' dzisiaj', tgtNF: '' });
  assert.equal(tr.pvExtra.length, 0);

  // Non-final translation tokens attach to the pending block in the preview.
  seg.ingest([o(' dzisiaj'), nf(t('Hermanos')), nf(t(' y'))]);
  assert.equal(tr.blocks[0].src, 'Bracia i siostry, dzisiaj');
  assert.equal(tr.blocks[0].tgt, '');
  assert.deepEqual(tr.pvMods.get(1), { srcNF: '', tgtNF: 'Hermanos y' });

  seg.ingest([t('Hermanos'), t(' y'), t(' hermanas'), t(','), t(' hoy')]);
  assert.equal(tr.blocks[0].tgt, 'Hermanos y hermanas, hoy');
  assert.equal(tr.blocks[0].tgtLang, 'es');
  assert.equal(tr.blocks[0].srcLang, 'pl');
  assert.equal(tr.pvMods.size, 0);

  // Next chunk continues the same paragraph (no endpoint yet).
  seg.ingest([o(' Ewangelia'), o(' mówi'), t(' el'), t(' Evangelio'), t(' dice')]);
  assert.equal(tr.blocks.length, 1);
  assert.equal(tr.blocks[0].src, 'Bracia i siostry, dzisiaj Ewangelia mówi');
  assert.equal(tr.blocks[0].tgt, 'Hermanos y hermanas, hoy el Evangelio dice');
});

test('endpoint before the translation: translation still lands in the closed paragraph', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Módlmy'), o(' się'), o('.'), END]);
  assert.equal(tr.blocks.length, 1);
  assert.equal(tr.blocks[0].closed, true);
  seg.ingest([t('Oremos'), t('.')]);
  assert.equal(tr.blocks[0].tgt, 'Oremos.');
  seg.ingest([o('Pan'), o(' z'), o(' wami'), o('.')]);
  assert.equal(tr.blocks.length, 2);
  assert.equal(tr.blocks[1].src, 'Pan z wami.');
  seg.ingest([t('El'), t(' Señor'), t(' esté'), t(' con'), t(' ustedes'), t('.'), END]);
  assert.equal(tr.blocks[1].tgt, 'El Señor esté con ustedes.');
  assert.equal(tr.blocks[0].tgt, 'Oremos.');
});

test('endpoint after the translation starts a new paragraph', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Amen'), o('.'), t('Amén'), t('.'), END, o(' Idźcie'), o(' w'), o(' pokoju')]);
  assert.equal(tr.blocks.length, 2);
  assert.equal(tr.blocks[0].src, 'Amen.');
  assert.equal(tr.blocks[0].tgt, 'Amén.');
  assert.equal(tr.blocks[1].src, 'Idźcie w pokoju');
});

test('two-way: each direction gets its own bubble with the right languages', () => {
  const { tr, seg } = setup({ twoWay: true, mode: 'conversar' });
  seg.ingest([o('Dzień', 'pl'), o(' dobry', 'pl'), o('!', 'pl'), t('Buenos', 'es', 'pl'), t(' días', 'es', 'pl'), t('!', 'es', 'pl'), END]);
  seg.ingest([o('Quisiera', 'es'), o(' dos', 'es'), o(' panecillos', 'es'), END]);
  seg.ingest([t('Poproszę', 'pl', 'es'), t(' dwie', 'pl', 'es'), t(' bułki', 'pl', 'es')]);
  assert.equal(tr.blocks.length, 2);
  const [a, b] = tr.blocks;
  assert.deepEqual([a.src, a.tgt, a.srcLang, a.tgtLang], ['Dzień dobry!', 'Buenos días!', 'pl', 'es']);
  assert.deepEqual([b.src, b.tgt, b.srcLang, b.tgtLang], ['Quisiera dos panecillos', 'Poproszę dwie bułki', 'es', 'pl']);
  assert.equal(b.m, 'conversar');
});

test('two-way: language switch splits even without an endpoint, translations matched by source language', () => {
  const { tr, seg } = setup({ twoWay: true });
  // Polish chunk, then Spanish speech starts before the Polish translation arrived.
  seg.ingest([o('Ile', 'pl'), o(' kosztuje', 'pl'), o('?', 'pl')]);
  seg.ingest([o('Con', 'es'), o(' tarjeta', 'es')]);
  seg.ingest([t('¿Cuánto', 'es', 'pl'), t(' cuesta', 'es', 'pl'), t('?', 'es', 'pl')]);
  seg.ingest([t('Kartą', 'pl', 'es')]);
  assert.equal(tr.blocks.length, 2);
  assert.equal(tr.blocks[0].tgt, '¿Cuánto cuesta?');
  assert.equal(tr.blocks[1].tgt, 'Kartą');
});

test('one-way: untranslated (none) speech gets its own block; pending translation still attaches', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Dziękuję'), n('Gracias', 'es')]);
  seg.ingest([t('Gracias'), t('.')]);
  assert.equal(tr.blocks.length, 2);
  assert.equal(tr.blocks[0].kind, 'orig');
  assert.equal(tr.blocks[0].tgt, 'Gracias.');
  assert.equal(tr.blocks[1].kind, 'none');
  assert.equal(tr.blocks[1].src, 'Gracias');
  assert.equal(tr.blocks[1].tgt, '');
});

test('long speech is split into paragraphs at sentence ends', () => {
  const { tr, seg } = setup({ twoWay: false });
  const sentence = 'To jest bardzo długie zdanie o miłosierdziu Bożym i nadziei.';
  let total = 0;
  while (total < SOFT_MAX + 10) {
    seg.ingest([o(' ' + sentence)]);
    seg.ingest([t(' Esta es una frase muy larga.')]);
    total += sentence.length + 1;
  }
  assert.equal(tr.blocks.length, 1);
  seg.ingest([o(' Następne'), o(' zdanie')]);
  assert.equal(tr.blocks.length, 2, 'new paragraph after soft max at a chunk boundary');
  assert.equal(tr.blocks[1].src, 'Następne zdanie');
  assert.equal(tr.blocks[0].closed, true);
});

test('endStream keeps on-screen provisional text and resets state', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Chwała'), nf(o(' Tobie')), nf(o(' Panie'))]);
  seg.endStream({ keepPreview: true });
  assert.equal(tr.blocks.length, 1);
  assert.equal(tr.blocks[0].src, 'Chwała Tobie Panie');
  assert.equal(tr.blocks[0].closed, true);
  assert.equal(tr.pvMods.size, 0);
  assert.equal(tr.pvExtra.length, 0);
  // A new stream starts a fresh paragraph.
  seg.ingest([o('Amen')]);
  assert.equal(tr.blocks.length, 2);
});

test('endStream without keepPreview drops provisional text', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Chwała'), nf(o(' Tobie'))]);
  seg.endStream({ keepPreview: false });
  assert.equal(tr.blocks[0].src, 'Chwała');
});

test('preview never mutates committed blocks', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Oto'), o(' słowo')]);
  const before = JSON.stringify(tr.blocks);
  seg.ingest([nf(o(' Boże')), nf(t('Palabra')), nf(o(' Następne'))]);
  assert.equal(JSON.stringify(tr.blocks), before);
  assert.equal(tr.pvMods.get(1).srcNF.startsWith(' Boże'), true);
});

test('flush reports dirty blocks and preview changes', () => {
  const { tr, seg } = setup({ twoWay: false });
  const changes = [];
  tr.onChange((c) => changes.push(c));
  seg.ingest([o('Alleluja'), nf(o(' alleluja'))]);
  tr.flush();
  assert.equal(changes.length, 1);
  assert.deepEqual([...changes[0].dirty], [1]);
  assert.deepEqual([...changes[0].preview], [1]);
  seg.ingest([o(' alleluja')]);
  tr.flush();
  assert.deepEqual([...changes[1].dirty], [1]);
  assert.deepEqual([...changes[1].preview], [1], 'preview cleared for block 1');
  assert.equal(tr.flush(), false, 'nothing new to flush');
});

test('resetForNewTranscript drops translations that belong to the old text', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Stary'), o(' tekst')]);
  tr.clear();
  seg.resetForNewTranscript();
  seg.ingest([t('Texto'), t(' viejo')]);
  assert.equal(tr.blocks.length, 0, 'orphan translation ignored');
  seg.ingest([o('Nowy'), t('Nuevo')]);
  assert.equal(tr.blocks.length, 1);
  assert.equal(tr.blocks[0].src, 'Nowy');
  assert.equal(tr.blocks[0].tgt, 'Nuevo');
});

test('endStream reports paragraphs whose translation may be cut off', () => {
  const { tr, seg } = setup({ twoWay: false });
  seg.ingest([o('Drodzy'), o(' bracia'), t('Queridos'), nf(t(' hermanos'))]);
  const incomplete = seg.endStream({ keepPreview: true });
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0], tr.blocks[0]);
  assert.equal(tr.blocks[0].tgt, 'Queridos hermanos');
  assert.deepEqual(seg.endStream({ keepPreview: false }), []);
});
