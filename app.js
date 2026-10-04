(() => {
  'use strict';

  /* ------------------------------------------------------------------ dados */

  const BOOKS = window.BANCO || [];
  const BOOK_COLORS = { fme1: '#C2531B', fme3: '#0F7480', fme4: '#6D4AA8', fme5: '#B02E68', fme9: '#7A6A10' };
  const BOOK = new Map(BOOKS.map(b => [b.id, b]));
  const QUESTIONS = [];
  const BY_ID = new Map();

  for (const b of BOOKS) {
    b.tag = `FME ${b.vol}`;
    b.color = BOOK_COLORS[b.id] || '#1F3FA6';
    for (const r of b.q) {
      const [kind, n, page, x1, x2, y1, y2, cont, group, ap, ax, ay, sol] = r;
      const q = {
        id: `${b.id}-${kind ? 'v' : 'p'}${n}`, book: b, kind, n, page, x1, x2, y1, y2, cont, group, ap, ax, ay, sol,
        topic: kind ? -1 : b.sub[group].c,
      };
      QUESTIONS.push(q);
      BY_ID.set(q.id, q);
    }
  }

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const pct = x => (x == null ? 'sem dados' : `${Math.round(x * 100)}%`);

  const qName = q => `${q.kind ? 'Vestibular' : 'Exercício'} ${q.n}`;
  const subLabel = q => (q.kind ? q.book.tp[q.group].t : q.book.sub[q.group].t.join(', '));
  const topicLabel = q => (q.kind ? 'Questões de vestibulares' : q.book.ch[q.topic].t);
  const tag = b => `<span class="tag" style="--book:${b.color}">${b.tag}</span>`;
  const qTag = q => `<span class="qtag" style="--book:${q.book.color}"><span>${q.book.tag}</span><strong>${qName(q)}</strong></span>`;

  const scopesOf = q => {
    const b = q.book.id;
    return q.kind ? ['all', b, `${b}/v`, `${b}/v/t${q.group}`] : ['all', b, `${b}/c${q.topic}`, `${b}/c${q.topic}/s${q.group}`];
  };
  const COUNTS = {};
  for (const q of QUESTIONS) for (const k of scopesOf(q)) COUNTS[k] = (COUNTS[k] || 0) + 1;

  /* --------------------------------------------------------------- progresso */

  const KEY = 'banco-fme:v1';
  const store = Object.assign(
    { res: {}, flag: {}, notes: {}, log: [], timerDur: 25 * 60, theme: '', books: [], topics: [], subs: false, f: { status: 'all' } },
    (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })(),
  );

  function save() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { toast('Não foi possível salvar o progresso neste navegador.'); }
  }
  let saveTimer = 0;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }; // enquanto se digita
  window.addEventListener('pagehide', () => { if (saveTimer) save(); });
  // outra aba do site gravou: adota o progresso dela em vez de sobrescrever depois
  window.addEventListener('storage', ev => {
    if (ev.key !== KEY || !ev.newValue) return;
    try { const d = JSON.parse(ev.newValue); Object.assign(store, { res: d.res || {}, flag: d.flag || {}, notes: d.notes || {}, log: d.log || [] }); } catch { /* ignora */ }
  });

  function summarize(list) {
    let c = 0, e = 0;
    for (const q of list) {
      const r = store.res[q.id];
      if (r === 'c') c++; else if (r === 'e') e++;
    }
    return { c, e, done: c + e, total: list.length, acc: c + e ? c / (c + e) : null };
  }

  /* --------------------------------------------------------------------- PDFs */

  const pdfjs = window.pdfjsLib;
  if (pdfjs) pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  // A pasta livros/ só é lida quando o site roda no próprio computador; hospedado, cada pessoa carrega o seu PDF.
  const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

  const idb = {
    db: null,
    open() {
      return this.db || (this.db = new Promise((res, rej) => {
        const r = indexedDB.open('banco-fme', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('pdfs');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      }));
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('pdfs', mode);
        const rq = fn(t.objectStore('pdfs'));
        t.oncomplete = () => res(rq.result);
        t.onerror = () => rej(t.error);
      });
    },
    get: k => idb.tx('readonly', s => s.get(k)),
    put: (k, v) => idb.tx('readwrite', s => s.put(v, k)),
    del: k => idb.tx('readwrite', s => s.delete(k)),
  };

  const pdfs = {
    cache: new Map(),
    source: new Map(), // id -> 'navegador' | 'pasta' | ''
    get(book) {
      if (!this.cache.has(book.id)) this.cache.set(book.id, this.load(book));
      return this.cache.get(book.id);
    },
    async load(book) {
      this.source.set(book.id, '');
      if (!pdfjs) return null;
      try {
        const file = await idb.get(book.id).catch(() => null);
        if (file) {
          const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
          this.source.set(book.id, 'navegador');
          return doc;
        }
        if (IS_LOCAL) {
          const url = 'livros/' + encodeURIComponent(book.f);
          if ((await fetch(url, { method: 'HEAD' })).ok) {
            const doc = await pdfjs.getDocument({ url }).promise;
            this.source.set(book.id, 'pasta');
            return doc;
          }
        }
      } catch (err) { console.warn('PDF não carregado:', book.f, err); }
      return null;
    },
    async add(book, file) {
      const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      await idb.put(book.id, file);
      this.cache.set(book.id, Promise.resolve(doc));
      this.source.set(book.id, 'navegador');
      pages.clear();
      return doc.numPages;
    },
    async remove(book) {
      await idb.del(book.id);
      this.cache.delete(book.id);
      pages.clear();
    },
  };

  const SCALE = Math.min(3, 2 * (window.devicePixelRatio || 1)); // pixels por ponto do PDF
  const ZOOM = 2.05; // tamanho na tela, em px por ponto do PDF
  const pages = new Map(); // "livro:página" -> Promise<canvas>

  function pageCanvas(doc, book, n) {
    const key = `${book.id}:${n}`;
    if (!pages.has(key)) {
      pages.set(key, (async () => {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: SCALE });
        const c = document.createElement('canvas');
        c.width = Math.ceil(vp.width);
        c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise; // 'print' não espera a aba estar visível
        return c;
      })());
      if (pages.size > 8) pages.delete(pages.keys().next().value);
    }
    return pages.get(key);
  }

  /** Recorta a região r (em pontos do PDF) de uma página; mark destaca o número da resposta. */
  async function crop(doc, book, r, mark) {
    const src = await pageCanvas(doc, book, Math.min(Math.max(r.page, 1), doc.numPages));
    const sx = Math.max(0, r.x1 * SCALE), sy = Math.max(0, r.y1 * SCALE);
    const sw = Math.min(src.width - sx, (r.x2 - r.x1) * SCALE), sh = Math.min(src.height - sy, (r.y2 - r.y1) * SCALE);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw));
    c.height = Math.max(1, Math.round(sh));
    const ctx = c.getContext('2d');
    ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    if (mark) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = '#FFE45C';
      ctx.fillRect((mark.x - r.x1 - 3) * SCALE, (mark.y - r.y1 - 1.5) * SCALE, 27 * SCALE, 12.5 * SCALE);
    }
    c.style.width = `min(100%, ${Math.round((r.x2 - r.x1) * ZOOM)}px)`;
    return c;
  }

  /** Apara as faixas em branco acima e abaixo do recorte; devolve null se não sobrar nada. */
  function trimmed(c) {
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const blank = y => {
      for (let x = 0, i = y * width * 4; x < width; x += 3, i += 12) if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) return false;
      return true;
    };
    let top = 0, bottom = height - 1;
    while (top < bottom && blank(top)) top++;
    while (bottom > top && blank(bottom)) bottom--;
    if (top === bottom && blank(top)) return null;
    const pad = Math.round(5 * SCALE);
    top = Math.max(0, top - pad);
    bottom = Math.min(height - 1, bottom + pad);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = bottom - top + 1;
    out.getContext('2d').drawImage(c, 0, top, width, out.height, 0, 0, width, out.height);
    out.style.width = c.style.width;
    return out;
  }

  function pickPdf(book) {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/pdf,.pdf' });
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      if (!pdfjs) return toast('O leitor de PDF não carregou. Verifique a conexão e recarregue a página.');
      toast(`Carregando o PDF do ${book.tag}…`);
      try {
        const n = await pdfs.add(book, file);
        toast(n === book.np
          ? `PDF do ${book.tag} carregado.`
          : `PDF carregado, mas ele tem ${n} páginas e o índice foi feito para a edição de ${book.np}. As questões podem aparecer deslocadas.`, 7000);
        route();
      } catch (err) {
        console.warn(err);
        toast('Não foi possível ler esse arquivo. Escolha um PDF.');
      }
    };
    input.click();
  }

  /* ---------------------------------------------------------------- navegação */

  const view = $('#view');
  let nav = null;        // { ids, session, started }
  let bankNum = '';
  let qv = null;         // estado da questão aberta
  let drawToken = 0;
  let clockInt = 0;

  function route() {
    clearInterval(clockInt);
    qv = null;
    drawToken++;
    const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
    const current = name === 'q' ? 'banco' : name === 'desempenho' || name === 'livros' ? name : 'banco';
    $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === current));
    if (!BOOKS.length) return void (view.innerHTML = '<div class="empty"><h2>Nenhum índice encontrado</h2><p>Rode <code>python build_index.py</code> para gerar o arquivo data.js.</p></div>');
    if (name === 'q' && BY_ID.has(arg)) return viewQuestion(BY_ID.get(arg));
    if (name === 'desempenho') return viewStats();
    if (name === 'livros') return viewBooks();
    viewBank();
  }
  const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };

  /* ------------------------------------------------------------------- banco */

  function inScope(q, scope) {
    if (scope === 'all') return true;
    const [bid, a, s] = scope.split('/');
    if (q.book.id !== bid) return false;
    if (!a) return true;
    if (a === 'v') return q.kind === 1 && (!s || q.group === +s.slice(1));
    return q.kind === 0 && q.topic === +a.slice(1) && (!s || q.group === +s.slice(1));
  }

  // Tópico = capítulo do livro; as questões de vestibulares de cada livro formam um tópico à parte.
  const topicKey = q => (q.kind ? `${q.book.id}/v` : `${q.book.id}/c${q.topic}`);
  const TOPICS = [];
  for (const b of BOOKS) {
    b.ch.forEach((ch, ci) => { if (COUNTS[`${b.id}/c${ci}`]) TOPICS.push({ key: `${b.id}/c${ci}`, book: b, title: ch.t }); });
    if (COUNTS[`${b.id}/v`]) TOPICS.push({ key: `${b.id}/v`, book: b, title: 'Questões de vestibulares' });
  }
  const TOPIC = new Map(TOPICS.map(t => [t.key, t]));
  QUESTIONS.forEach((q, i) => { q.order = i; });

  // store.books vazio = todos os livros; store.topics vazio = todos os tópicos desses livros
  const bookOn = b => !store.books.length || store.books.includes(b.id);

  function tidySelection() {
    const chosen = new Set(store.books);
    store.books = BOOKS.map(b => b.id).filter(id => chosen.has(id));
    if (store.books.length === BOOKS.length) store.books = [];
    store.topics = store.topics.filter(k => TOPIC.has(k) && bookOn(TOPIC.get(k).book));
  }

  const STATUS = {
    todo: q => !store.res[q.id], c: q => store.res[q.id] === 'c', e: q => store.res[q.id] === 'e',
    flag: q => store.flag[q.id], sol: q => q.sol,
  };

  /** Questões dos livros e tópicos escolhidos que passam pelos filtros de situação e número. */
  function filtered() {
    const topics = new Set(store.topics);
    const pass = STATUS[store.f.status];
    return QUESTIONS.filter(q => bookOn(q.book)
      && (!topics.size || topics.has(topicKey(q)))
      && (!pass || pass(q))
      && (!bankNum || String(q.n).startsWith(bankNum)));
  }

  function selectionText() {
    const books = store.books.length ? store.books.map(id => BOOK.get(id).tag).join(', ') : 'todos os livros';
    const topics = !store.topics.length ? 'todos os tópicos'
      : store.topics.length <= 3 ? store.topics.map(k => TOPIC.get(k).title).join('; ') : `${store.topics.length} tópicos`;
    return `${books}, ${topics}`;
  }

  const STATUS_WORD = { c: 'acertei', e: 'errei' };
  function cellHTML(q) {
    const r = store.res[q.id];
    const label = `${q.book.tag}, ${qName(q).toLowerCase()}${r ? ', ' + STATUS_WORD[r] : ''}${store.flag[q.id] ? ', para revisar' : ''}${q.sol ? ', resolvida no livro' : ''}`;
    return `<a class="cell${r ? ' ' + r : ''}${store.flag[q.id] ? ' flag' : ''}${q.sol ? ' sol' : ''}" href="#/q/${q.id}" title="${label}" aria-label="${label}">${q.n}</a>`;
  }

  function groupsHTML(list) {
    if (!list.length) return '<div class="empty"><h2>Nenhuma questão com esses filtros</h2><p>Mude a situação ou o número procurado.</p><button class="btn btn-ink" type="button" data-act="clear-filters">Limpar filtros</button></div>';
    const manyBooks = new Set(list.map(q => q.book)).size > 1;
    const topics = new Map();
    for (const q of list) {
      const k = topicKey(q);
      if (!topics.has(k)) topics.set(k, []);
      topics.get(k).push(q);
    }
    let html = '';
    for (const [k, qs] of topics) {
      const t = TOPIC.get(k), s = summarize(qs);
      let cells = `<div class="cells">${qs.map(cellHTML).join('')}</div>`;
      if (store.subs) {
        const subs = new Map();
        for (const q of qs) {
          if (!subs.has(q.group)) subs.set(q.group, []);
          subs.get(q.group).push(q);
        }
        cells = [...subs.values()].map(g => `<div class="subgroup"><h4>${esc(subLabel(g[0]))}</h4><div class="cells">${g.map(cellHTML).join('')}</div></div>`).join('');
      }
      html += `<section class="group">
        <header class="group-head">
          <h3>${manyBooks ? tag(t.book) : ''}${esc(t.title)}</h3>
          <p>${plural(qs.length, 'questão', 'questões')}${s.done ? `, ${s.done} ${s.done === 1 ? 'feita' : 'feitas'}` : ''}</p>
        </header>
        ${cells}
      </section>`;
    }
    return html;
  }

  function viewBank() {
    tidySelection();
    const opt = (v, t) => `<option value="${v}"${v === store.f.status ? ' selected' : ''}>${t}</option>`;
    const chip = (attr, value, on, label) => `<button class="chip" type="button" ${attr}="${value}" aria-pressed="${on}">${label}</button>`;
    const shown = BOOKS.filter(bookOn);
    view.innerHTML = `
      <div class="bank">
        <h1 class="sr-only">Questões</h1>
        <section class="picker" aria-labelledby="lblBooks">
          <h2 id="lblBooks">Livros</h2>
          <div class="chips">
            ${chip('data-pickbook', '', !store.books.length, 'Todos')}
            ${BOOKS.map(b => chip('data-pickbook', b.id, store.books.includes(b.id), `<span class="chip-tag" style="--book:${b.color}">${b.tag}</span>${esc(b.t)}`)).join('')}
          </div>
        </section>
        <section class="picker" aria-labelledby="lblTopics">
          <h2 id="lblTopics">Tópicos</h2>
          <div class="chips">${chip('data-picktopic', '', !store.topics.length, 'Todos')}</div>
          ${shown.map(b => `<div class="chips chips-book">${shown.length > 1 ? tag(b) : ''}${TOPICS.filter(t => t.book === b).map(t => chip('data-picktopic', t.key, store.topics.includes(t.key), esc(t.title))).join('')}</div>`).join('')}
        </section>
        <div class="toolbar">
          <label class="field"><span>Situação</span><select id="fStatus">${opt('all', 'Todas')}${opt('todo', 'Ainda não fiz')}${opt('c', 'Acertei')}${opt('e', 'Errei')}${opt('flag', 'Para revisar')}${opt('sol', 'Resolvidas no livro')}</select></label>
          <label class="field field-num"><span>Número da questão</span><input id="fNum" type="text" inputmode="numeric" placeholder="ex.: 245" value="${esc(bankNum)}"></label>
          <label class="check" id="subsWrap"><input id="fSubs" type="checkbox"${store.subs ? ' checked' : ''}><span>Separar por subtópico</span></label>
          <div class="toolbar-actions">
            <button class="btn btn-line" type="button" data-act="pdf">Baixar em PDF</button>
            <button class="btn btn-ink" type="button" data-act="draw">Sortear lista</button>
          </div>
        </div>
        <p class="count" id="count"></p>
        <div id="groups"></div>
        <ul class="legend" id="legend" aria-label="Legenda">
          <li><span class="cell c" aria-hidden="true">1</span>Acertei</li>
          <li><span class="cell e" aria-hidden="true">2</span>Errei</li>
          <li><span class="cell flag" aria-hidden="true">3</span>Para revisar</li>
          <li><span class="cell sol" aria-hidden="true">4</span>Resolvida no livro</li>
        </ul>
      </div>`;
    paintGroups();
  }

  function paintGroups() {
    const list = filtered();
    const s = summarize(list);
    // sem tópico, situação ou número escolhidos, a página não despeja milhares de questões de uma vez
    const showing = !!(store.topics.length || bankNum || STATUS[store.f.status]);
    $('#count').textContent = `${plural(list.length, 'questão', 'questões')} na seleção${list.length ? `: ${s.c} ${s.c === 1 ? 'acerto' : 'acertos'}, ${s.e} ${s.e === 1 ? 'erro' : 'erros'}, ${list.length - s.done} por fazer` : ''}.`;
    $('#groups').innerHTML = showing ? groupsHTML(list)
      : '<p class="hint">Escolha um ou mais tópicos para ver as questões. Sem escolher nenhum, “Sortear lista” e “Baixar em PDF” usam todos os tópicos dos livros selecionados.</p>';
    $('#legend').hidden = $('#subsWrap').hidden = !(showing && list.length);
  }

  /** Diálogo para montar uma lista: mode 'draw' começa a resolver, 'pdf' baixa o arquivo. */
  function listDialog(mode) {
    const list = filtered();
    const todo = list.filter(q => !store.res[q.id]).length;
    const pdf = mode === 'pdf';
    const all = pdf && list.length <= 40;
    openDialog(`
      <form method="dialog" class="dlg" id="listForm">
        <h2>${pdf ? 'Baixar lista em PDF' : 'Sortear uma lista'}</h2>
        <p>${plural(list.length, 'questão', 'questões')} na seleção atual, ${todo} ainda por fazer.</p>
        <label class="check"><input type="radio" name="how" value="draw"${all ? '' : ' checked'}><span>Sortear</span><input class="qty" name="n" type="number" min="1" max="${Math.max(1, list.length)}" value="${Math.min(pdf ? 20 : 10, Math.max(1, list.length))}" aria-label="Quantidade de questões"><span>questões</span></label>
        <label class="check"><input type="radio" name="how" value="all"${all ? ' checked' : ''}><span>Todas, na ordem do livro</span></label>
        <label class="check"><input name="todo" type="checkbox"${todo && !pdf ? ' checked' : ''}${todo ? '' : ' disabled'}><span>Só as que ainda não fiz</span></label>
        ${pdf ? `<label class="check"><input name="crops" type="checkbox" checked><span>Incluir os enunciados, recortados do seu PDF</span></label>
        <p class="muted">Sem os enunciados, o arquivo traz só a relação de livro, número e página. Listas com mais de 100 enunciados demoram e ficam pesadas.</p>` : ''}
        <div class="dlg-actions">
          <button class="btn btn-quiet" type="button" data-close>Cancelar</button>
          <button class="btn btn-ink" type="submit"${list.length ? '' : ' disabled'}>${pdf ? 'Baixar PDF' : 'Começar a lista'}</button>
        </div>
      </form>`);
    $('#listForm').onsubmit = ev => {
      const fd = new FormData(ev.target);
      let picked = fd.get('todo') ? list.filter(q => !store.res[q.id]) : list.slice();
      if (fd.get('how') === 'draw') {
        for (let i = picked.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [picked[i], picked[k]] = [picked[k], picked[i]]; }
        picked = picked.slice(0, Math.max(1, +fd.get('n') || 10));
        if (pdf) picked.sort((a, b) => a.order - b.order);
      }
      if (!picked.length) return;
      if (pdf) return void downloadPdf(picked, !!fd.get('crops'));
      nav = { ids: picked.map(q => q.id), session: true, started: Date.now() };
      go(`#/q/${nav.ids[0]}`);
    };
  }

  const loadScript = src => new Promise((res, rej) => {
    const s = Object.assign(document.createElement('script'), { src, onload: res, onerror: () => rej(new Error(src)) });
    document.head.append(s);
  });
  // as fontes padrão do PDF só têm os caracteres latinos
  const latin = s => String(s).replace(/[—–]/g, '-').replace(/[^\x00-\xFF]/g, '');

  /** Monta e baixa um PDF com a lista: cabeçalho, e para cada questão o livro, o número e o enunciado. */
  async function downloadPdf(list, withCrops) {
    toast('Preparando o PDF…', 120000);
    try {
      if (!window.jspdf) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    } catch {
      return toast('Não foi possível carregar o gerador de PDF. Verifique a conexão e tente de novo.');
    }
    try {
      const missing = await buildPdf(list, withCrops);
      toast(missing
        ? `PDF baixado. ${plural(missing, 'questão ficou', 'questões ficaram')} sem enunciado porque o PDF do livro não está carregado.`
        : 'PDF baixado.', 6000);
    } catch (err) {
      console.warn(err);
      toast('Não foi possível gerar o PDF. Tente de novo com menos questões.', 6000);
    }
  }

  /** Escreve a lista no PDF e dispara o download; devolve quantas questões ficaram sem enunciado. */
  async function buildPdf(list, withCrops) {
    const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const M = 48, W = pdf.internal.pageSize.getWidth() - 2 * M, BOTTOM = pdf.internal.pageSize.getHeight() - M;
    let y = M;
    const room = h => { if (y + h > BOTTOM) { pdf.addPage(); y = M; } };
    const ink = () => pdf.setTextColor(30, 36, 48), grey = () => pdf.setTextColor(88, 97, 118);

    pdf.setFont('helvetica', 'bold').setFontSize(20);
    ink();
    pdf.text('Lista de exercícios', M, y + 16);
    y += 36;
    pdf.setFont('helvetica', 'normal').setFontSize(10);
    grey();
    const about = `${plural(list.length, 'questão', 'questões')} - ${selectionText()} - ${new Date().toLocaleDateString('pt-BR')}`;
    for (const line of pdf.splitTextToSize(latin(about), W)) { pdf.text(line, M, y); y += 13; }
    y += 14;

    let missing = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (i % 4 === 0) toast(`Gerando o PDF: questão ${i + 1} de ${list.length}…`, 120000);
      let crops = [];
      if (withCrops) {
        const doc = await pdfs.get(q.book);
        if (doc) crops = await cropsOf(doc, q, false); else missing++;
      }
      // tamanho na folha: 20% maior que no livro, limitado à largura e à altura úteis
      const sizes = crops.map(cv => {
        let w = Math.min(W, (cv.width / SCALE) * 1.2), h = (cv.height * w) / cv.width;
        if (h > BOTTOM - M) { w *= (BOTTOM - M) / h; h = BOTTOM - M; }
        return [w, h];
      });
      room(30 + (sizes.length ? Math.min(sizes[0][1], 220) : 0));
      pdf.setFont('helvetica', 'bold').setFontSize(11);
      ink();
      pdf.text(latin(`${i + 1}.  ${q.book.tag} - ${qName(q)}`), M, y + 10);
      pdf.setFont('helvetica', 'normal').setFontSize(9);
      grey();
      pdf.text(latin(crops.length ? topicLabel(q) : `${topicLabel(q)} - página ${q.page} do PDF do livro`), M, y + 23);
      y += 32;
      crops.forEach((cv, k) => {
        const [w, h] = sizes[k];
        room(h);
        pdf.addImage(cv.toDataURL('image/jpeg', 0.9), 'JPEG', M, y, w, h);
        y += h + 4;
      });
      y += crops.length ? 14 : 2;
    }
    pdf.save(`lista-de-exercicios-${dayKey(Date.now())}.pdf`);
    return missing;
  }

  /* ----------------------------------------------------------------- questão */

  function viewQuestion(q) {
    if (!nav || !nav.ids.includes(q.id)) {
      nav = { ids: QUESTIONS.filter(o => topicKey(o) === topicKey(q)).map(o => o.id), session: false };
    }
    qv = { q, full: false, fullPage: q.page, showSol: false, showAns: false, ansFull: false, opened: Date.now() };
    const i = nav.ids.indexOf(q.id), n = nav.ids.length;
    view.innerHTML = `
      <div class="qwrap">
        <div class="qbar">
          <a class="back" href="#/">Voltar às questões</a>
          ${nav.session
            ? `<span class="pos">Lista sorteada, questão ${i + 1} de ${n}</span><button class="btn btn-quiet" type="button" data-act="end">Encerrar lista</button>`
            : `<span class="pos">${i + 1} de ${n} nesta lista</span>`}
        </div>
        <div class="qgrid">
          <article class="sheet">
            <header class="qhead">
              ${qTag(q)}
              <p class="qpath"><span>${esc(topicLabel(q))}</span><span>${esc(subLabel(q))}</span></p>
            </header>
            <div class="paper" id="paper"><p class="loading">Abrindo a página…</p></div>
            <div class="tools">
              ${q.sol ? '<button class="btn btn-line" type="button" data-act="sol" id="solBtn">Mostrar a resolução do livro</button>' : ''}
              <button class="btn btn-line" type="button" data-act="ans" id="ansBtn">Ver a resposta do gabarito</button>
              <button class="btn btn-quiet" type="button" data-act="full" id="fullBtn">Ver a página inteira</button>
              <span class="pagenav" id="pageNav" hidden>
                <button class="btn btn-quiet" type="button" data-act="pg-" aria-label="Página anterior">‹</button>
                <span id="pageNo"></span>
                <button class="btn btn-quiet" type="button" data-act="pg+" aria-label="Página seguinte">›</button>
              </span>
            </div>
            <div class="answer" id="answer"></div>
          </article>

          <aside class="qside">
            <section class="panel">
              <h2>Como você foi?</h2>
              <div class="marks">
                <button class="mark mark-c" type="button" data-res="c" aria-pressed="false">Acertei</button>
                <button class="mark mark-e" type="button" data-res="e" aria-pressed="false">Errei</button>
              </div>
              <button class="link" type="button" data-act="unmark" id="unmark" hidden>Desfazer a marcação</button>
              <label class="check flagger"><input id="flag" type="checkbox"><span>Marcar para revisar</span></label>
              <p class="clock">Tempo nesta questão <strong id="qClock">0:00</strong></p>
            </section>
            <section class="panel">
              <h2><label for="notes">Minha resolução e anotações</label></h2>
              <textarea id="notes" rows="7" placeholder="Escreva aqui o caminho da resolução, o erro que cometeu ou um lembrete.">${esc(store.notes[q.id] || '')}</textarea>
            </section>
            <nav class="step" aria-label="Outras questões">
              <button class="btn btn-quiet" type="button" data-act="prev"${i === 0 ? ' disabled' : ''}>Anterior</button>
              <button class="btn btn-ink" type="button" data-act="next">${i === n - 1 ? (nav.session ? 'Concluir a lista' : 'Voltar às questões') : 'Próxima'}</button>
            </nav>
            <p class="keys">Atalhos: ← e → mudam de questão, C acertei, E errei, R revisar, G gabarito, espaço inicia ou pausa o cronômetro.</p>
          </aside>
        </div>
      </div>`;
    paintMarks();
    drawPaper();
    clockInt = setInterval(() => { const el = $('#qClock'); if (el && qv) el.textContent = fmt(Math.floor((Date.now() - qv.opened) / 1000)); }, 1000);
    window.scrollTo(0, 0);
  }

  function paintMarks() {
    if (!qv) return;
    const r = store.res[qv.q.id];
    $$('.mark').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.res === r)));
    $('#unmark').hidden = !r;
    $('#flag').checked = !!store.flag[qv.q.id];
  }

  function noPdfHTML(q) {
    const b = q.book;
    return `<div class="nopdf">
      <h3>Carregue o PDF do ${b.tag} para ver o enunciado</h3>
      <p>O site guarda só o índice das questões. O enunciado é recortado do seu arquivo, que fica apenas neste navegador e não é enviado para lugar nenhum.</p>
      <button class="btn btn-ink" type="button" data-pick="${b.id}">Escolher o PDF do ${b.tag}</button>
      <p class="muted">Sem o PDF dá para resolver pelo livro: é o ${qName(q).toLowerCase()}, na página ${q.page} do arquivo.</p>
    </div>`;
  }

  /** Regiões da página (em pontos do PDF) que formam o enunciado; a resolução do livro só entra com showSol. */
  function partsOf(q, showSol) {
    const hide = q.sol && !showSol;
    const parts = [{ page: q.page, x1: q.x1, x2: q.x2, y1: q.y1, y2: hide && q.sol > 0 ? q.sol : q.y2 }];
    if (q.cont && !(hide && q.sol > 0)) {
      const [dp, x1, x2, y1, y2] = q.cont; // continua na coluna ou página seguinte
      parts.push({ page: q.page + dp, x1, x2, y1, y2: hide ? -q.sol : y2 });
    }
    return parts.filter(p => p.y2 - p.y1 > 4);
  }

  async function cropsOf(doc, q, showSol) {
    const out = [];
    for (const p of partsOf(q, showSol)) {
      const t = trimmed(await crop(doc, q.book, p));
      if (t) out.push(t);
    }
    return out;
  }

  async function drawPaper() {
    const paper = $('#paper');
    if (!qv || !paper) return;
    const token = ++drawToken;
    const { q } = qv, b = q.book;
    const doc = await pdfs.get(b);
    if (token !== drawToken) return;
    if (!doc) return void (paper.innerHTML = pdfjs ? noPdfHTML(q) : '<div class="nopdf"><h3>O leitor de PDF não carregou</h3><p>Verifique a conexão com a internet e recarregue a página.</p></div>');

    const canvases = qv.full
      ? [await crop(doc, b, { page: qv.fullPage, x1: 0, y1: 0, x2: b.w, y2: b.h })]
      : await cropsOf(doc, q, qv.showSol);
    if (token !== drawToken) return;
    paper.replaceChildren(...canvases);
    paper.classList.toggle('full', qv.full);
    $('#pageNav').hidden = !qv.full;
    $('#pageNo').textContent = `página ${qv.fullPage} de ${doc.numPages}`;
    $('#fullBtn').textContent = qv.full ? 'Voltar ao recorte da questão' : 'Ver a página inteira';
    const solBtn = $('#solBtn');
    if (solBtn) { solBtn.textContent = qv.showSol ? 'Esconder a resolução do livro' : 'Mostrar a resolução do livro'; solBtn.hidden = qv.full; }
  }

  async function drawAnswer() {
    const box = $('#answer');
    if (!qv || !box) return;
    $('#ansBtn').textContent = qv.showAns ? 'Esconder a resposta' : 'Ver a resposta do gabarito';
    if (!qv.showAns) return void (box.innerHTML = '');
    const { q } = qv, b = q.book, has = q.ay >= 0;
    const token = drawToken;
    const doc = await pdfs.get(b);
    if (token !== drawToken) return;
    if (!doc) return void (box.innerHTML = '<p class="muted">Carregue o PDF do livro para ver o gabarito.</p>');
    let html = `<h3>Gabarito do livro</h3>`;
    if (!has) {
      html += `<p>O gabarito não traz resposta para o ${qName(q).toLowerCase()}. Isso é comum em demonstrações${q.sol ? ' e em exercícios resolvidos: a resolução deste está no próprio livro, logo abaixo do enunciado' : ''}.</p>`;
    }
    box.innerHTML = html + (has || qv.ansFull ? '<div class="paper" id="ansPaper"></div>' : '')
      + `<button class="link" type="button" data-act="ansfull">${qv.ansFull ? 'Mostrar só o trecho da resposta' : has ? 'Ver a página inteira do gabarito' : 'Abrir a página mais próxima do gabarito'}</button>`;
    if (!has && !qv.ansFull) return;
    const r = qv.ansFull || !has
      ? { page: q.ap, x1: 0, y1: 0, x2: b.w, y2: b.h }
      : { page: q.ap, x1: 24, x2: b.w - 24, y1: Math.max(b.top - 2, q.ay - 16), y2: Math.min(b.h - 30, q.ay + 110) };
    const c = await crop(doc, b, r, has ? { x: q.ax, y: q.ay } : null);
    if (token !== drawToken || !$('#ansPaper')) return;
    $('#ansPaper').replaceChildren(c);
  }

  function mark(res) {
    if (!qv) return;
    const { q } = qv;
    store.res[q.id] = res;
    store.log.push({ i: q.id, r: res, t: Date.now(), s: Math.min(3600, Math.round((Date.now() - qv.opened) / 1000)) });
    save();
    paintMarks();
    toast(`${q.book.tag}, ${qName(q).toLowerCase()}: ${res === 'c' ? 'acerto registrado' : 'erro registrado'}.`);
  }

  function unmark() {
    if (!qv) return;
    const id = qv.q.id;
    delete store.res[id];
    for (let k = store.log.length - 1; k >= 0; k--) if (store.log[k].i === id) { store.log.splice(k, 1); break; }
    save();
    paintMarks();
  }

  function step(dir) {
    if (!qv || !nav) return;
    const i = nav.ids.indexOf(qv.q.id) + dir;
    if (i < 0) return;
    if (i >= nav.ids.length) return nav.session ? endSession() : go('#/');
    go(`#/q/${nav.ids[i]}`);
  }

  function endSession() {
    const qs = nav.ids.map(id => BY_ID.get(id));
    const since = nav.started;
    const tries = store.log.filter(l => l.t >= since && nav.ids.includes(l.i));
    const last = new Map(tries.map(l => [l.i, l.r]));
    const c = [...last.values()].filter(r => r === 'c').length, e = last.size - c;
    const secs = Math.round((Date.now() - since) / 1000);
    nav = { ids: nav.ids, session: false };
    openDialog(`
      <div class="dlg">
        <h2>Lista concluída</h2>
        <dl class="recap">
          <div><dt>Acertos</dt><dd>${c}</dd></div>
          <div><dt>Erros</dt><dd>${e}</dd></div>
          <div><dt>Sem marcar</dt><dd>${qs.length - last.size}</dd></div>
          <div><dt>Tempo total</dt><dd>${fmt(secs)}</dd></div>
        </dl>
        <p>${last.size ? `Aproveitamento de ${pct(c / last.size)} nas questões marcadas.` : 'Nenhuma questão foi marcada como acerto ou erro.'}</p>
        <div class="dlg-actions">
          <button class="btn btn-quiet" type="button" data-close data-go="#/">Voltar às questões</button>
          <button class="btn btn-ink" type="button" data-close data-go="#/desempenho">Ver o desempenho</button>
        </div>
      </div>`);
  }

  /* -------------------------------------------------------------- desempenho */

  const DAY = 86400000;
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dayLabel = t => new Date(t).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });

  function barHTML(s, cls = '') {
    const seg = (n, c, word) => n ? `<i class="seg ${c}" style="flex:${n} 0 3px" data-tip="${n} ${word}"></i>` : '';
    return `<div class="bar ${cls}" role="img" aria-label="${s.c} acertos, ${s.e} erros, ${s.total - s.done} por fazer">${seg(s.c, 'good', s.c === 1 ? 'acerto' : 'acertos')}${seg(s.e, 'bad', s.e === 1 ? 'erro' : 'erros')}${seg(s.total - s.done, 'rest', 'por fazer')}</div>`;
  }

  function dailyChart() {
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const days = [];
    for (let k = 29; k >= 0; k--) days.push({ t: today.getTime() - k * DAY, c: 0, e: 0 });
    const idx = new Map(days.map((d, i) => [dayKey(d.t), i]));
    for (const l of store.log) { const i = idx.get(dayKey(l.t)); if (i !== undefined) days[i][l.r]++; }
    const top = Math.max(4, ...days.map(d => d.c + d.e));
    const unit = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000].find(u => u * 4 >= top) || Math.ceil(top / 4);
    const max = unit * 4;
    const W = 720, H = 190, L = 30, R = 6, T = 10, B = 24, band = (W - L - R) / 30, bw = 12, ph = H - T - B;
    const y = v => T + ph - (v / max) * ph;
    const cap = (x, y0, h) => h <= 0 ? '' : `M${x},${y0 + h} v${-(h - Math.min(4, h))} q0,${-Math.min(4, h)} ${Math.min(4, h)},${-Math.min(4, h)} h${bw - 2 * Math.min(4, h)} q${Math.min(4, h)},0 ${Math.min(4, h)},${Math.min(4, h)} v${h - Math.min(4, h)} z`;
    let svg = '';
    for (const v of [0, unit * 2, max]) svg += `<line class="gridline" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    days.forEach((d, i) => {
      const x = L + i * band + (band - bw) / 2;
      const hc = (d.c / max) * ph, he = (d.e / max) * ph;
      if (d.c) svg += d.e ? `<rect class="good" x="${x}" y="${y(d.c)}" width="${bw}" height="${hc}"/>` : `<path class="good" d="${cap(x, y(d.c), hc)}"/>`;
      if (d.e) svg += `<path class="bad" d="${cap(x, y(d.c + d.e) - (d.c ? 2 : 0), he)}"/>`;
      if (i % 5 === 4 || i === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${dayLabel(d.t)}</text>`;
      svg += `<rect class="hit" x="${L + i * band}" y="${T}" width="${band}" height="${ph}" data-tip="${dayLabel(d.t)}: ${d.c} ${d.c === 1 ? 'acerto' : 'acertos'}, ${d.e} ${d.e === 1 ? 'erro' : 'erros'}"/>`;
    });
    const rows = days.filter(d => d.c + d.e).reverse().map(d => `<tr><td>${dayLabel(d.t)}</td><td>${d.c}</td><td>${d.e}</td></tr>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Acertos e erros por dia nos últimos 30 dias">${svg}</svg>
      <details class="astable"><summary>Ver como tabela</summary><table><thead><tr><th>Dia</th><th>Acertos</th><th>Erros</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Nenhuma questão marcada nos últimos 30 dias.</td></tr>'}</tbody></table></details>`;
  }

  function streak() {
    const set = new Set(store.log.map(l => dayKey(l.t)));
    let t = Date.now(), n = 0;
    if (!set.has(dayKey(t))) t -= DAY;
    while (set.has(dayKey(t))) { n++; t -= DAY; }
    return n;
  }

  function viewStats() {
    const all = summarize(QUESTIONS);
    if (!all.done) {
      view.innerHTML = `<div class="page"><h1>Desempenho</h1><div class="empty"><h2>Ainda não há o que mostrar</h2><p>Abra uma questão, resolva e marque se acertou ou errou. O seu desempenho por livro, tópico e subtópico aparece aqui.</p><a class="btn btn-ink" href="#/">Ir para as questões</a></div></div>`;
      return;
    }
    const timed = store.log.filter(l => l.s > 0);
    const avg = timed.length ? Math.round(timed.reduce((a, l) => a + l.s, 0) / timed.length) : 0;
    const days = streak();

    const topics = [];
    for (const b of BOOKS) {
      const add = (scope, title) => {
        const qs = QUESTIONS.filter(q => inScope(q, scope));
        if (!qs.length) return;
        const subs = new Map();
        for (const q of qs) { const k = `${scope}/${q.kind ? 't' : 's'}${q.group}`; if (!subs.has(k)) subs.set(k, { scope: k, title: subLabel(q), qs: [] }); subs.get(k).qs.push(q); }
        topics.push({ b, scope, title, s: summarize(qs), subs: [...subs.values()].map(x => ({ ...x, s: summarize(x.qs) })) });
      };
      b.ch.forEach((c, ci) => add(`${b.id}/c${ci}`, c.t));
      add(`${b.id}/v`, 'Questões de vestibulares');
    }
    topics.sort((x, y) => (y.s.done > 0) - (x.s.done > 0) || (x.s.acc ?? 2) - (y.s.acc ?? 2) || y.s.done - x.s.done);

    const line = (label, s, scope, lead = '') => `
      <span class="t-name">${lead}<button class="link" type="button" data-scope="${scope}" title="Abrir nas questões">${esc(label)}</button></span>
      <span class="t-done">${s.done} de ${s.total}</span>
      <span class="t-acc">${s.done ? pct(s.acc) : '—'}</span>
      ${barHTML(s, 'thin')}`;

    const recent = store.log.slice(-8).reverse().map(l => {
      const q = BY_ID.get(l.i);
      return q ? `<li><a href="#/q/${q.id}">${qTag(q)}</a><span class="res ${l.r}">${l.r === 'c' ? 'Acertei' : 'Errei'}</span><span class="muted">${l.s ? fmt(l.s) : ''}</span><span class="muted">${dayLabel(l.t)}</span></li>` : '';
    }).join('');

    view.innerHTML = `
      <div class="page">
        <h1>Desempenho</h1>
        <dl class="tiles">
          <div><dt>Questões feitas</dt><dd>${all.done}<small> de ${all.total}</small></dd></div>
          <div><dt>Taxa de acerto</dt><dd>${pct(all.acc)}</dd></div>
          <div><dt>Tempo médio por questão</dt><dd>${avg ? fmt(avg) : '—'}</dd></div>
          <div><dt>Dias seguidos estudando</dt><dd>${days}</dd></div>
        </dl>

        <section class="card">
          <header class="card-head"><h2>Últimos 30 dias</h2>
            <ul class="key"><li><i class="sw good"></i>✓ Acertos</li><li><i class="sw bad"></i>✗ Erros</li></ul></header>
          ${dailyChart()}
        </section>

        <section class="card">
          <header class="card-head"><h2>Por livro</h2>
            <ul class="key"><li><i class="sw good"></i>✓ Acertos</li><li><i class="sw bad"></i>✗ Erros</li><li><i class="sw rest"></i>Por fazer</li></ul></header>
          <div class="books-prog">
            ${BOOKS.map(b => { const s = summarize(QUESTIONS.filter(q => q.book === b)); return `<div class="bp">
              <p class="bp-name">${tag(b)}<button class="link" type="button" data-scope="${b.id}">${esc(b.t)}</button></p>
              <p class="bp-num">${s.done} de ${s.total} feitas${s.done ? `, ${pct(s.acc)} de acerto` : ''}</p>
              ${barHTML(s)}</div>`; }).join('')}
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h2>Por tópico e subtópico</h2><p class="muted">Os tópicos em que você mais erra aparecem primeiro. Clique em um tópico para abrir os subtópicos.</p></header>
          <div class="topics">
            <div class="t-row t-headrow"><span>Tópico</span><span>Feitas</span><span>Acerto</span><span></span></div>
            ${topics.map(t => `<details class="topic"><summary class="t-row">${line(t.title, t.s, t.scope, tag(t.b))}</summary>
              ${t.subs.map(x => `<div class="t-row t-sub">${line(x.title, x.s, x.scope)}</div>`).join('')}</details>`).join('')}
          </div>
        </section>

        <section class="card">
          <header class="card-head"><h2>Últimas questões marcadas</h2></header>
          <ul class="recent">${recent}</ul>
        </section>
      </div>`;
  }

  /* ------------------------------------------------------------ livros e dados */

  function viewBooks() {
    view.innerHTML = `
      <div class="page">
        <h1>Livros e dados</h1>
        <p class="lede">O site guarda só o índice das questões: livro, tópico, subtópico, número e posição na página. O enunciado é recortado do PDF que você carregar aqui. O arquivo fica guardado apenas neste navegador e não é enviado para lugar nenhum.</p>
        <section class="card">
          <header class="card-head"><h2>Seus PDFs</h2></header>
          <ul class="shelf">
            ${BOOKS.map(b => `<li data-book="${b.id}">
              <div class="shelf-name">${tag(b)}<strong>${esc(b.t)}</strong><span class="muted">${COUNTS[b.id]} questões no índice, edição de ${b.np} páginas</span></div>
              <p class="shelf-status" data-status>Verificando…</p>
              <div class="shelf-actions"><button class="btn btn-line" type="button" data-pick="${b.id}">Escolher PDF</button><button class="btn btn-quiet" type="button" data-unpick="${b.id}" hidden>Remover deste navegador</button></div>
            </li>`).join('')}
          </ul>
        </section>
        <section class="card">
          <header class="card-head"><h2>Seu progresso</h2><p class="muted">Acertos, erros, marcações e anotações ficam salvos neste navegador. Exporte um arquivo para guardar uma cópia ou levar para outro computador.</p></header>
          <div class="data-actions">
            <button class="btn btn-line" type="button" data-act="export">Exportar progresso</button>
            <button class="btn btn-line" type="button" data-act="import">Importar progresso</button>
            <button class="btn btn-danger" type="button" data-act="wipe">Apagar progresso</button>
          </div>
        </section>
      </div>`;
    for (const b of BOOKS) {
      pdfs.get(b).then(doc => {
        const li = $(`[data-book="${b.id}"]`);
        if (!li) return;
        const src = pdfs.source.get(b.id);
        $('[data-status]', li).textContent = !doc ? 'Nenhum PDF carregado.'
          : src === 'pasta' ? 'Lido da pasta livros deste computador.'
          : `Guardado neste navegador${doc.numPages !== b.np ? ` (tem ${doc.numPages} páginas; o índice espera ${b.np})` : ''}.`;
        li.classList.toggle('ok', !!doc);
        $('[data-unpick]', li).hidden = src !== 'navegador';
      });
    }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ app: 'banco-fme', v: 1, res: store.res, flag: store.flag, notes: store.notes, log: store.log }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `progresso-banco-de-questoes-${dayKey(Date.now())}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importData() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
    input.onchange = async () => {
      try {
        const d = JSON.parse(await input.files[0].text());
        if (d.app !== 'banco-fme' || typeof d.res !== 'object') throw new Error('formato');
        if (!confirm('Importar substitui o progresso salvo neste navegador. Continuar?')) return;
        Object.assign(store, { res: d.res || {}, flag: d.flag || {}, notes: d.notes || {}, log: Array.isArray(d.log) ? d.log : [] });
        save();
        toast('Progresso importado.');
        route();
      } catch { toast('Esse arquivo não é um progresso exportado por este site.'); }
    };
    input.click();
  }

  /* --------------------------------------------------------------- cronômetro */

  const fmt = s => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  const timer = { left: store.timerDur, running: false, endAt: 0, int: 0, done: false };
  const tEl = $('#timer'), tTime = $('#timerTime'), tToggle = $('#timerToggle'), tPop = $('#timerPop');

  function paintTimer() {
    tTime.textContent = fmt(timer.left);
    tToggle.textContent = timer.running ? 'Pausar' : timer.left < store.timerDur && timer.left > 0 ? 'Continuar' : 'Iniciar';
    tEl.classList.toggle('running', timer.running);
    tEl.classList.toggle('done', timer.done);
    document.title = timer.running ? `${fmt(timer.left)} · Banco de questões` : 'Banco de questões';
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach(at => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.28);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + 0.3);
      });
    } catch { /* sem áudio */ }
  }

  function tick() {
    timer.left = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
    if (!timer.left) {
      clearInterval(timer.int);
      timer.running = false;
      timer.done = true;
      beep();
      toast('Tempo esgotado.', 6000);
    }
    paintTimer();
  }

  function toggleTimer() {
    if (timer.running) {
      clearInterval(timer.int);
      timer.running = false;
    } else {
      if (!timer.left) timer.left = store.timerDur;
      timer.done = false;
      timer.endAt = Date.now() + timer.left * 1000;
      timer.running = true;
      timer.int = setInterval(tick, 250);
    }
    paintTimer();
  }

  function setTimer(secs) {
    clearInterval(timer.int);
    Object.assign(timer, { left: secs, running: false, done: false });
    store.timerDur = secs;
    save();
    paintTimer();
    paintPresets();
  }

  const PRESETS = [5, 10, 15, 20, 25, 30, 45, 60, 90, 120];
  function paintPresets() {
    $('#timerPresets').innerHTML = PRESETS.map(m => `<button type="button" class="preset${store.timerDur === m * 60 ? ' on' : ''}" data-min="${m}">${m < 60 ? `${m} min` : m === 60 ? '1 h' : `${m / 60} h`.replace('.', ',')}</button>`).join('');
  }
  function popTimer(show) {
    tPop.hidden = !show;
    tTime.setAttribute('aria-expanded', String(show));
  }

  tTime.onclick = () => popTimer(tPop.hidden);
  tToggle.onclick = toggleTimer;
  $('#timerReset').onclick = () => setTimer(store.timerDur);
  $('#timerPresets').onclick = ev => { const b = ev.target.closest('[data-min]'); if (b) { setTimer(+b.dataset.min * 60); popTimer(false); } };
  $('#timerCustom').onsubmit = ev => {
    ev.preventDefault();
    const m = Math.round(+$('#timerMin').value);
    if (m >= 1 && m <= 600) { setTimer(m * 60); popTimer(false); $('#timerMin').value = ''; }
  };
  document.addEventListener('click', ev => { if (!tPop.hidden && !tEl.contains(ev.target)) popTimer(false); });

  /* ------------------------------------------------------- avisos e diálogos */

  let toastTimer = 0;
  function toast(msg, ms = 3200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), ms);
  }

  const dialog = $('#dialog');
  function openDialog(html) {
    dialog.innerHTML = html;
    if (!dialog.open) dialog.showModal();
  }
  dialog.addEventListener('click', ev => {
    const b = ev.target.closest('[data-close]');
    if (ev.target === dialog || b) dialog.close();
    if (b && b.dataset.go) go(b.dataset.go);
  });

  const tip = $('#tip');
  document.addEventListener('mousemove', ev => {
    const el = ev.target.closest && ev.target.closest('[data-tip]');
    if (!el) return void (tip.hidden = true);
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, ev.clientX + 12)}px`;
    tip.style.top = `${ev.clientY - tip.offsetHeight - 10}px`;
  });

  /* ------------------------------------------------------------------ eventos */

  /** Abre as questões de um livro, tópico ou subtópico (links da tela de desempenho). */
  function setScope(scope) {
    const [bid, a, s] = scope.split('/');
    store.books = BOOK.has(bid) ? [bid] : [];
    store.topics = a ? [`${bid}/${a}`] : [];
    store.subs = !!s;
    store.f.status = 'all';
    bankNum = '';
    save();
    if (location.hash && location.hash !== '#/') go('#/'); else viewBank();
    window.scrollTo(0, 0);
  }

  function toggleChip(key, value) {
    if (!value) store[key] = [];
    else store[key] = store[key].includes(value) ? store[key].filter(v => v !== value) : [...store[key], value];
    save();
    viewBank();
    const again = $(`[data-pick${key === 'books' ? 'book' : 'topic'}="${value}"]`);
    if (again) again.focus();
  }

  view.addEventListener('click', ev => {
    const t = ev.target;
    const cell = t.closest('a.cell');
    if (cell) { nav = { ids: filtered().map(q => q.id), session: false }; return; }
    const bookChip = t.closest('[data-pickbook]');
    if (bookChip) return toggleChip('books', bookChip.dataset.pickbook);
    const topicChip = t.closest('[data-picktopic]');
    if (topicChip) return toggleChip('topics', topicChip.dataset.picktopic);
    const scope = t.closest('[data-scope]');
    if (scope) return setScope(scope.dataset.scope);
    const pick = t.closest('[data-pick]');
    if (pick) return pickPdf(BOOK.get(pick.dataset.pick));
    const unpick = t.closest('[data-unpick]');
    if (unpick) return void pdfs.remove(BOOK.get(unpick.dataset.unpick)).then(() => { toast('PDF removido deste navegador.'); route(); });
    const res = t.closest('[data-res]');
    if (res) return mark(res.dataset.res);
    const act = t.closest('[data-act]');
    if (!act) return;
    switch (act.dataset.act) {
      case 'draw': listDialog('draw'); break;
      case 'pdf': listDialog('pdf'); break;
      case 'clear-filters': store.f.status = 'all'; bankNum = ''; save(); viewBank(); break;
      case 'sol': qv.showSol = !qv.showSol; drawPaper(); break;
      case 'ans': qv.showAns = !qv.showAns; qv.ansFull = false; drawAnswer(); break;
      case 'ansfull': qv.ansFull = !qv.ansFull; drawAnswer(); break;
      case 'full': qv.full = !qv.full; qv.fullPage = qv.q.page; drawPaper(); break;
      case 'pg-': qv.fullPage = Math.max(1, qv.fullPage - 1); drawPaper(); break;
      case 'pg+': qv.fullPage = Math.min(qv.q.book.np, qv.fullPage + 1); drawPaper(); break;
      case 'unmark': unmark(); break;
      case 'prev': step(-1); break;
      case 'next': step(1); break;
      case 'end': endSession(); break;
      case 'export': exportData(); break;
      case 'import': importData(); break;
      case 'wipe':
        if (confirm('Apagar todos os acertos, erros, marcações e anotações deste navegador? Isso não pode ser desfeito.')) {
          Object.assign(store, { res: {}, flag: {}, notes: {}, log: [] });
          save();
          toast('Progresso apagado.');
        }
        break;
    }
  });

  view.addEventListener('change', ev => {
    const t = ev.target;
    if (t.id === 'fStatus') store.f.status = t.value;
    else if (t.id === 'fSubs') store.subs = t.checked;
    else if (t.id === 'flag' && qv) { if (t.checked) store.flag[qv.q.id] = 1; else delete store.flag[qv.q.id]; return save(); }
    else return;
    save();
    paintGroups();
  });

  view.addEventListener('input', ev => {
    const t = ev.target;
    if (t.id === 'fNum') { bankNum = t.value.replace(/\D/g, ''); paintGroups(); }
    if (t.id === 'notes' && qv) { if (t.value.trim()) store.notes[qv.q.id] = t.value; else delete store.notes[qv.q.id]; saveSoon(); }
  });

  document.addEventListener('keydown', ev => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || dialog.open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    const k = ev.key.toLowerCase();
    if (k === ' ' && ev.target.tagName !== 'BUTTON' && ev.target.tagName !== 'A') { ev.preventDefault(); return toggleTimer(); }
    if (!qv) return;
    if (k === 'arrowright') step(1);
    else if (k === 'arrowleft') step(-1);
    else if (k === 'c') mark('c');
    else if (k === 'e') mark('e');
    else if (k === 'g') { qv.showAns = !qv.showAns; qv.ansFull = false; drawAnswer(); }
    else if (k === 'r') { const f = $('#flag'); f.checked = !f.checked; f.dispatchEvent(new Event('change', { bubbles: true })); }
  });

  const themeBtn = $('#theme');
  function paintTheme() {
    document.documentElement.dataset.theme = store.theme;
    themeBtn.textContent = store.theme === 'lousa' ? 'Caderno' : 'Lousa';
    themeBtn.setAttribute('aria-pressed', String(store.theme === 'lousa'));
  }
  themeBtn.onclick = () => { store.theme = store.theme === 'lousa' ? '' : 'lousa'; save(); paintTheme(); };

  window.addEventListener('hashchange', route);
  paintTheme();
  paintPresets();
  paintTimer();
  route();
})();
