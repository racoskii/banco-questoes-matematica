"""Gera data.js: um indice (livro, topico, subtopico, numero, pagina, area) dos exercicios dos PDFs em livros/.

O texto dos exercicios nao e copiado: o site recorta a questao do PDF que o usuario carrega.
Uso: python build_index.py
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

ROOT = Path(__file__).parent
BOOKS = ROOT / "livros"

# arquivo -> (volume, titulo, 1a pag. dos capitulos, 1a pag. das respostas,
#             1a pag. das questoes de vestibulares, 1a pag. das respostas dos vestibulares)
LIVROS = {
    "FME-1-Conjuntos-e-funcoes.pdf": (1, "Conjuntos e funções", 9, 278, 321, 412),
    "FME-3-Trigonometria.pdf": (3, "Trigonometria", 12, 257, 277, 315),
    "FME-4-Sequencias-matrizes-determinantes-e-sistemas.pdf": (4, "Sequências, matrizes, determinantes e sistemas", 9, 201, 216, 284),
    "FME-5-Combinatoria-e-probabilidade.pdf": (5, "Combinatória e probabilidade", 7, 154, 165, 206),
    "FME-9-Geometria-plana.pdf": (9, "Geometria plana", 11, 361, 384, 461),
}

NUM = re.compile(r"^\s*(\d{1,4})\.(\s|$)")
SECTION = re.compile(r"^\s*[IVXL]+\.\s+(\S.*)$")
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50}
COLUMN = 200  # x a partir do qual um numero esta na segunda coluna


def roman(s):
    total = 0
    for a, b in zip(s, s[1:] + " "):
        v = ROMAN[a]
        total += -v if b in ROMAN and ROMAN[b] > v else v
    return total


def is_white(color):
    return all(v >= 0.97 for v in color)


def merge(intervals, tol=1.0):
    """Junta intervalos (a, b) que se tocam ou quase."""
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1] + tol:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def cluster(boxes, width, height, cell=2.5):
    """Agrupa caixas vizinhas (figuras, tabelas, caixas de resolucao) e devolve a caixa de cada grupo.

    Pinta as caixas numa grade e junta as manchas que se tocam; o custo cresce com o numero de
    caixas, nao com o quadrado dele (ha paginas com mais de cem mil tracos).
    """
    ncols, nrows = int(width / cell) + 3, int(height / cell) + 3
    grid = [bytearray(ncols) for _ in range(nrows)]
    corners = []
    for b in boxes:
        c0, c1 = max(0, int(b[0] / cell)), min(ncols - 1, int(b[2] / cell) + 1)  # uma celula de folga
        r0, r1 = max(0, int(b[1] / cell)), min(nrows - 1, int(b[3] / cell) + 1)
        fill = b"\x01" * (c1 - c0 + 1)
        for r in range(r0, r1 + 1):
            grid[r][c0:c1 + 1] = fill
        corners.append((r0, c0))
    label = [[0] * ncols for _ in range(nrows)]
    count = 0
    for r in range(nrows):
        c = grid[r].find(1)
        while c != -1:
            if not label[r][c]:
                count += 1
                label[r][c] = count
                stack = [(r, c)]
                while stack:
                    y, x = stack.pop()
                    for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                        if 0 <= ny < nrows and 0 <= nx < ncols and grid[ny][nx] and not label[ny][nx]:
                            label[ny][nx] = count
                            stack.append((ny, nx))
            c = grid[r].find(1, c + 1)
    groups = {}
    for b, (r0, c0) in zip(boxes, corners):
        g = groups.setdefault(label[r0][c0], list(b))
        g[0], g[1], g[2], g[3] = min(g[0], b[0]), min(g[1], b[1]), max(g[2], b[2]), max(g[3], b[3])
    return list(groups.values())


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


class Pages:
    """Linhas de texto de cada pagina, lidas uma unica vez."""

    def __init__(self, doc):
        self.doc = doc
        self.h = doc[0].rect.height
        self._cache = {}
        self._drawn = {}

    def drawn(self, page):
        """Caixas (x0, y0, x1, y1) do que esta desenhado no corpo da pagina: tracos visiveis e imagens.

        Um mesmo objeto do PDF pode juntar tracos de varias figuras, entao cada traco vira uma caixa.
        """
        if page not in self._drawn:
            pg = self.doc[page - 1]
            W, H = pg.rect.width, pg.rect.height
            top, bottom = self.bounds(page)
            out = []
            masks = {}  # nivel -> moldura visivel em vigor (mapas e fotos sao maiores que a moldura)
            for dr in pg.get_drawings(extended=True):
                level = dr.get("level", 0)
                for done in [k for k in masks if k >= level]:
                    del masks[done]
                if dr["type"] == "clip":
                    masks[level] = dr["scissor"]
                    continue
                if dr["type"] == "group":
                    continue
                fill, stroke = dr.get("fill"), dr.get("color")
                if (fill is None or is_white(fill)) and (stroke is None or is_white(stroke)):
                    continue  # fundos brancos e contornos invisiveis
                if dr["rect"].width > W * 0.9 and dr["rect"].height > H * 0.9:
                    continue  # marcas de corte da pagina
                mask = masks[max(masks)] if masks else pg.rect
                for it in dr["items"]:
                    if it[0] == "re":
                        pts = [it[1].tl, it[1].br]
                    elif it[0] == "qu":
                        pts = [it[1].ul, it[1].ur, it[1].ll, it[1].lr]
                    else:
                        pts = [p for p in it[1:] if hasattr(p, "x")]
                    if not pts:
                        continue
                    box = (max(mask.x0, min(p.x for p in pts)), max(mask.y0, min(p.y for p in pts)),
                           min(mask.x1, max(p.x for p in pts)), min(mask.y1, max(p.y for p in pts)))
                    if box[0] <= box[2] and box[1] <= box[3]:
                        out.append(box)
            out += [(l["x"], l["y"], l["x1"], l["y1"]) for l in self.lines(page) if not l["font"]]  # imagens
            self._drawn[page] = [b for b in out if b[3] >= top and b[1] <= bottom and b[2] >= 0 and b[0] <= W]
        return self._drawn[page]

    def lines(self, page):
        if page not in self._cache:
            out = []
            for block in self.doc[page - 1].get_text("dict")["blocks"]:
                if block["type"] == 1:  # imagem
                    out.append({"font": "", "size": 0, "x": block["bbox"][0], "x1": block["bbox"][2], "y": block["bbox"][1], "y1": block["bbox"][3], "text": "", "spans": []})
                for line in block.get("lines", []):
                    s = line["spans"][0]
                    out.append({
                        "font": s["font"], "size": round(s["size"], 1),
                        "x": line["bbox"][0], "x1": line["bbox"][2], "y": line["bbox"][1], "y1": line["bbox"][3],
                        "text": "".join(x["text"] for x in line["spans"]),
                        "spans": [(x["font"], round(x["size"], 1), x["bbox"][0], x["bbox"][1], x["text"]) for x in line["spans"]],
                    })
            self._cache[page] = sorted(out, key=lambda l: (l["y"], l["x"]))
        return self._cache[page]

    def bounds(self, page):
        """Faixa util da pagina, sem cabecalho nem rodape."""
        top, bottom = 40, self.h - 40
        for l in self.lines(page):
            if l["font"].startswith("Eurostile") and 0 < l["size"] < 10:
                if l["y"] < 70:
                    top = max(top, l["y1"] + 5)
                elif l["y"] > self.h - 60:
                    bottom = min(bottom, l["y"] - 5)
        return top, bottom

    def body(self, page):
        top, bottom = self.bounds(page)
        return [l for l in self.lines(page) if top <= l["y"] <= bottom]


def numbered(pages, first, last, size):
    """Numeros de exercicio (fonte Demi no tamanho dado), na ordem de leitura."""
    out = []
    for page in range(first, last):
        found = []
        for l in pages.lines(page):
            for font, sz, x, y, text in l["spans"]:
                m = NUM.match(text)
                if m and "Dem" in font and sz == size:
                    found.append((int(m.group(1)), page, x, y))
        out += sorted(found, key=lambda f: (f[2] >= COLUMN, f[3]))  # paginas em duas colunas
    return out


def in_sequence(items):
    """Mantem a 1a ocorrencia de cada numero, descartando saltos para tras."""
    seen, out, prev = set(), [], 0
    for n, page, x, y in items:
        if n in seen or n < prev - 3 or n > prev + 60:
            continue
        seen.add(n)
        out.append((n, page, x, y))
        prev = max(prev, n)
    return sorted(out)


def answers(pages, first, last):
    """numero -> (pagina, x, y) da resposta (primeira ocorrencia)."""
    found = {}
    for n, page, x, y in numbered_any(pages, first, last):
        found.setdefault(n, (page, x, y))
    return found


def numbered_any(pages, first, last):
    for page in range(first, last):
        for l in pages.lines(page):
            for font, sz, x, y, text in l["spans"]:
                m = NUM.match(text)
                if m and "Dem" in font:
                    yield int(m.group(1)), page, x, y


def chapters(pages, first, last):
    titles = {}
    for p in range(4, 11):
        for m in re.finditer(r"CAPÍTULO\s+([IVXL]+)\s+[—–-]\s+(.+?)\s*\.{3,}", pages.doc[p].get_text()):
            titles[roman(m.group(1))] = clean(m.group(2))
    out = []
    for page in range(first, last):
        m = re.search(r"(?m)^\s*CAPÍTULO\s+([IVXL]+)\s*$", pages.doc[page - 1].get_text())
        if m:
            n = roman(m.group(1))
            if not out or out[-1]["n"] != n:
                out.append({"n": n, "t": titles.get(n, f"Capítulo {n}"), "p": page})
    return out


def headings(pages, first, last, size, numbered_only):
    """Titulos em Rockwell no tamanho dado; linhas seguidas sao um titulo so."""
    out = []
    for page in range(first, last):
        for l in pages.body(page):
            if not (l["font"].startswith("Rockwell") and abs(l["size"] - size) < 1 and len(l["text"].strip()) > 2):
                continue
            text = clean(l["text"])
            m = SECTION.match(text)
            follows = out and out[-1]["p"] == page and 0 < l["y"] - out[-1]["y1"] < 12
            if follows and not m:
                out[-1]["t"] += " " + text
                out[-1]["y1"] = l["y1"]
            elif m or (not numbered_only and not NUM.match(text)):
                out.append({"t": m.group(1) if m else text, "p": page, "y": l["y"], "y1": l["y1"]})
    return out


def is_title(l):
    return (l["font"].startswith("Rockwell") and l["size"] >= 12.5) or (l["font"].startswith("Eurostile") and l["size"] >= 14)


def columns(pages, page, by_page):
    """Faixas horizontais (x1, x2) das colunas de texto da pagina."""
    here = by_page.get(page, [])
    body = [l for l in pages.body(page) if l["text"].strip() and l["x"] > 30]
    lefts = [x for x, _ in here if x < COLUMN]
    if lefts:
        left = min(lefts)
    else:  # a margem alterna entre paginas pares e impares
        left = 43 if not body or min(l["x"] for l in body) < 57 else 71
    rights = [x for x, _ in here if x >= COLUMN]
    if rights:
        right = min(rights)
    else:
        # segunda coluna so com a continuacao de uma questao: nenhuma linha atravessa o meio da pagina
        starts = [l["x"] for l in body if left + 183 <= l["x"] <= left + 200]
        crossing = [l for l in body if l["x"] < left + 170 and l["x1"] > left + 200]
        near = any(x >= COLUMN for p in (page - 1, page + 1) for x, _ in by_page.get(p, []))
        if len(starts) < 6 or crossing or not near:
            return [(left - 8, left + 379)]
        right = min(starts)
    return [(left - 8, right - 12), (right - 8, left + 379)]


def regions(pages, numbers, last_page, width):
    """Para cada questao: (x1, x2, y1, y2, continuacao, inicio da resolucao do livro).

    O corte entre duas questoes fica no espaco em branco logo acima da primeira linha da questao
    seguinte, contando tambem formulas altas (fracoes, chaves, matrizes) e figuras ao lado do texto.
    Uma figura que atravessa o corte fica inteira com a questao em que esta a maior parte dela.
    Se a coluna acaba antes da questao, ela continua na coluna ou pagina seguinte:
    continuacao = [paginas adiante, x1, x2, y1, y2] ou 0.
    """
    by_page = {}
    for n, page, x, y in numbers:
        by_page.setdefault(page, []).append((x, y))
    cache, plans, layouts = {}, {}, {}

    def cols(page):
        if page not in cache:
            cache[page] = columns(pages, page, by_page)
        return cache[page]

    def layout(page):
        """Separa o texto corrido das figuras (com seus rotulos) e dos titulos."""
        if page in layouts:
            return layouts[page]
        top, bottom = pages.bounds(page)
        marks = {(round(x, 1), round(y, 1)) for x, y in by_page.get(page, [])}
        groups = cluster(pages.drawn(page), width, pages.h)
        # parenteses, colchetes e chaves desenhados (altos e estreitos) sao parte da linha, nao figuras
        bigs = [g for g in groups if g[3] - g[1] >= 14 and not (g[2] - g[0] < 12 and g[3] - g[1] <= 90)]
        figures = {id(g) for g in bigs}

        def host(box):
            cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
            return next((g for g in bigs if g[0] - 8 <= cx <= g[2] + 8 and g[1] - 8 <= cy <= g[3] + 8), None)

        flow, titles, grow = [], [], []
        for g in groups:
            if id(g) not in figures:  # tracinhos soltos ao lado de uma figura sao parte dela
                if host(g):
                    grow.append((host(g), g))
                else:
                    flow.append(g)
        for l in pages.body(page):
            if not l["text"].strip():
                continue
            box = [l["x"], l["y"], l["x1"], l["y1"]]
            numbered_line = any((round(sx, 1), round(sy, 1)) in marks for _, _, sx, sy, _ in l["spans"])
            if is_title(l):
                titles.append(box)
            elif not numbered_line and host(box):
                grow.append((host(box), box))  # rotulo de figura ou texto dentro de uma caixa
                continue
            flow.append(box)
        for g, box in grow:
            g[0], g[1], g[2], g[3] = min(g[0], box[0]), min(g[1], box[1]), max(g[2], box[2]), max(g[3], box[3])
        # a faixa decorada de um titulo ("EXERCICIOS") faz parte do titulo
        banners = [g for g in bigs if any(g[0] <= (t[0] + t[2]) / 2 <= g[2] and g[1] <= (t[1] + t[3]) / 2 <= g[3] for t in titles)]
        bigs = [g for g in bigs if g not in banners]
        for t in titles:
            for g in banners:
                if g[1] <= (t[1] + t[3]) / 2 <= g[3]:
                    t[1], t[3] = min(t[1], g[1]), max(t[3], g[3])
        layouts[page] = {"flow": flow + banners, "bigs": bigs, "titles": titles, "top": top, "bottom": bottom}
        return layouts[page]

    def plan(page, k):
        """Paradas da coluna (questoes e titulos) e, para cada uma, onde a regiao de cima termina
        e onde a de baixo comeca."""
        if (page, k) in plans:
            return plans[(page, k)]
        lay = layout(page)
        cs = cols(page)
        x1, x2 = cs[k]

        def inside(b):
            if len(cs) == 1 or x1 - 2 <= (b[0] + b[2]) / 2 <= x2 + 2:
                return True
            return b[0] < x1 + 20 and b[2] > x2 - 20  # atravessa a coluna inteira (titulo de secao)

        flow = [b for b in lay["flow"] if inside(b)]
        bigs = [b for b in lay["bigs"] if inside(b)]
        blocks = merge((b[1], b[3]) for b in flow)
        stops = sorted([(y, y + 10, (x, y)) for x, y in by_page.get(page, []) if x1 - 2 <= x <= x2]
                       + [(t[1], t[3], None) for t in lay["titles"] if inside(t)], key=lambda st: st[:2])
        cuts, floor = [], lay["top"]
        for s0, s1, ref in stops:
            mid = (s0 + min(s1, s0 + 10)) / 2
            block = next((bl for bl in blocks if bl[0] <= mid <= bl[1]), None)
            if block and block[0] >= floor - 0.01:
                g1 = block[0]
                g0 = min(max([bl[1] for bl in blocks if bl[1] <= g1] + [floor]), g1)
                cut = g1 - 0.5
            else:
                # linhas encostadas na questao de cima: corta onde menos texto e fatiado
                def sliced(y):
                    return sum(min(y - b[1], b[3] - y) for b in flow if b[1] < y < b[3])

                steps = int(max(0, s0 - floor) * 2) + 1
                cut = min((s0 - i * 0.5 for i in range(steps)), key=sliced)
                g0 = g1 = cut
            free = [[g0, g1]]
            for bg in bigs:
                free = [f for lo, hi in free for f in ([lo, min(hi, bg[1] - 1)], [max(lo, bg[3] + 1), hi]) if f[1] - f[0] >= 1.2]
            if free:
                down = up = sum(free[-1]) / 2
            else:
                down = up = cut
                for bg in bigs:
                    if bg[1] < cut < bg[3]:
                        if (bg[1] + bg[3]) / 2 > cut:
                            up = min(up, bg[1] - 2)
                        else:
                            down = max(down, bg[3] + 2)
                # a borda estendida por causa de uma figura nao deve fatiar uma linha da questao vizinha
                for _ in range(3):
                    if up < cut:
                        up = min([up] + [b[1] - 1 for b in flow if b[1] < up < b[3]])
                    if down > cut:
                        down = max([down] + [b[3] + 1 for b in flow if b[1] < down < b[3]])
            cuts.append((down, up))
            floor = s1
        plans[(page, k)] = (stops, cuts, flow + bigs, lay)
        return plans[(page, k)]

    def extent(page, k, ya, yb):
        """Faixa horizontal: a coluna, alargada para caber o que estiver desenhado nela."""
        boxes = plan(page, k)[2]
        x1, x2 = cols(page)[k]
        inside = [b for b in boxes if ya <= (b[1] + b[3]) / 2 <= yb]
        return max(0, min([x1] + [b[0] - 3 for b in inside])), min(width, max([x2] + [b[2] + 3 for b in inside]))

    def is_solution(l):
        return l["text"].strip().startswith("Solução") and "Dem" in l["font"]

    def solution_y(page, x1, x2, ya, yb):
        ys = [l["y"] for l in pages.body(page) if is_solution(l) and ya < l["y"] < yb and x1 <= l["x"] <= x2]
        if not ys:
            return 0
        y = min(ys)
        box = next((g for g in layout(page)["bigs"] if y - 30 < g[1] <= y <= g[3]), None)
        return (box[1] - 2) if box else (y - 13)  # a caixa cinza da resolucao comeca acima da palavra

    out = {}
    for n, page, x, y in numbers:
        cs = cols(page)
        k = 1 if len(cs) == 2 and x >= cs[1][0] else 0
        stops, cuts, boxes, lay = plan(page, k)
        i = next(j for j, st in enumerate(stops) if st[2] == (x, y))
        y1 = max(cuts[i][1], lay["top"] - 2)
        last = i + 1 == len(stops)
        y2 = lay["bottom"] + 2 if last else min(max(cuts[i + 1][0], y + 12), lay["bottom"] + 2)
        x1, x2 = extent(page, k, y1, y2)
        cont = 0
        if last:
            cpage, ck = (page, 1) if k == 0 and len(cs) == 2 else (page + 1, 0)
            if cpage < last_page:
                cstops, ccuts, cboxes, clay = plan(cpage, ck)
                cend = ccuts[0][0] if cstops else clay["bottom"] + 2
                if any(bx[1] < cend - 2 for bx in cboxes):
                    cx1, cx2 = extent(cpage, ck, clay["top"] - 2, cend)
                    cont = [cpage - page, round(cx1), round(cx2), round(clay["top"] - 2), round(cend)]
        # onde comeca a resolucao impressa no livro: y nesta pagina, -y na continuacao, 0 se nao ha
        solved = solution_y(page, x1, x2, y, y2)
        if not solved and cont:
            solved = -solution_y(page + cont[0], cont[1], cont[2], cont[3], cont[4])
        out[n] = (x1, x2, y1, y2, cont, round(solved))
    return out


def subtopics(chaps, sections, numbers):
    """Agrupa as secoes de teoria que antecedem cada bloco de exercicios em um subtopico."""
    subs, where = [], {}
    events = [(s["p"], s["y"], 0, s["t"]) for s in sections] + [(p, y, 1, n) for n, p, x, y in numbers]
    pending, current, current_chap = [], None, None
    for page, y, kind, value in sorted(events):
        chap = max((i for i, c in enumerate(chaps) if c["p"] <= page), default=0)
        if chap != current_chap:
            pending, current, current_chap = [], None, chap
        if kind == 0:
            pending.append(value)
        else:
            if pending or current is None:
                subs.append({"c": chap, "t": pending or ["Exercícios gerais"], "p": page})
                current, pending = len(subs) - 1, []
            where[value] = current
    return subs, where


def build(name, vol, title, c0, g0, v0, vg):
    doc = pymupdf.open(BOOKS / name)
    pages = Pages(doc)
    end = doc.page_count + 1
    chaps = chapters(pages, c0, g0)
    themes = headings(pages, v0, vg, 13, numbered_only=False)
    out = []
    report = []
    for kind, first, last, size, afirst, alast in ((0, c0, g0, 10.0, g0, v0), (1, v0, vg, 9.0, vg, end)):
        nums = in_sequence(numbered(pages, first, last, size))
        top = max((n for n, *_ in nums), default=0)
        report.append(f"{len(nums)}/{top}")
        ans = answers(pages, afirst, alast)
        area = regions(pages, nums, last, doc[0].rect.width)
        if kind == 0:
            groups, where = subtopics(chaps, headings(pages, c0, g0, 15, numbered_only=True), nums)
            subs = groups
        prev_ans = afirst
        for n, page, x, y in nums:
            x1, x2, y1, y2, cont, solved = area[n]
            if kind == 0:
                group = where[n]
            else:
                group = max((i for i, t in enumerate(themes) if (t["p"], t["y"]) <= (page, y)), default=0)
            apage, ax, ay = ans.get(n, (prev_ans, 0, -1))
            prev_ans = apage
            out.append([kind, n, page, round(x1), round(x2), round(y1), round(y2), cont, group, apage, round(ax), round(ay), solved])
    print(f"FME {vol}: propostos {report[0]}, vestibulares {report[1]}, {len(chaps)} tópicos, {len(subs)} subtópicos, {len(themes)} temas de vestibular")
    return {
        "id": f"fme{vol}", "vol": vol, "t": title, "f": name, "np": doc.page_count,
        "w": round(doc[0].rect.width, 1), "h": round(doc[0].rect.height, 1),
        "top": Counter(round(pages.bounds(p)[0]) for p in range(c0, vg)).most_common(1)[0][0],
        "ch": [{"n": c["n"], "t": c["t"]} for c in chaps],
        "sub": [{"c": s["c"], "t": s["t"]} for s in subs],
        "tp": [{"t": t["t"]} for t in themes],
        # [tipo (0 proposto, 1 vestibular), numero, pagina, x1, x2, y1, y2, continuacao ([paginas adiante, x1, x2, y1, y2] ou 0),
        #  subtopico ou tema, pagina da resposta, x, y (-1 = sem resposta no gabarito),
        #  y onde comeca a resolucao do livro (negativo = na pagina seguinte, 0 = nao ha)]
        "q": out,
    }


def main():
    data = []
    for name, args in LIVROS.items():
        if not (BOOKS / name).exists():
            print(f"[faltando] livros/{name}")
            continue
        data.append(build(name, *args))
    out = ROOT / "data.js"
    out.write_text("window.BANCO = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"{out.name}: {sum(len(b['q']) for b in data)} questões, {out.stat().st_size // 1024} KB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
