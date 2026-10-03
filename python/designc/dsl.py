"""Structurizr DSL subset -> model. A line-for-line port of tokenize/parse in renderer/core.js."""
import re
from types import SimpleNamespace as NS

_NUM = re.compile(r'\d+(?![\w.])', re.A)
_ID = re.compile(r'[A-Za-z_!][\w.]*', re.A)

KINDS = {'person': 'person', 'softwareSystem': 'softwareSystem', 'softwaresystem': 'softwareSystem',
         'container': 'container', 'component': 'component'}
SKIP = {'views', 'styles', 'configuration', 'deploymentEnvironment', '!docs', '!adrs', '!identifiers',
        '!impliedRelationships', 'branding', 'terminology'}
DEPLOY = {'deploymentNode', 'infrastructureNode', 'containerInstance', 'softwareSystemInstance'}


def tokenize(src):
    toks = []
    i, line, n = 0, 1, len(src)
    while i < n:
        c = src[i]
        if c == '\n':
            line += 1; i += 1; continue
        if c in ' \t\r':
            i += 1; continue
        if c == '/' and src[i + 1:i + 2] == '/':
            while i < n and src[i] != '\n': i += 1
            continue
        if c == '#':
            while i < n and src[i] != '\n': i += 1
            continue
        if c == '/' and src[i + 1:i + 2] == '*':
            i += 2
            while i < n and not (src[i] == '*' and src[i + 1:i + 2] == '/'):
                if src[i] == '\n': line += 1
                i += 1
            i += 2
            continue
        if c == '"':
            start, j, s = line, i + 1, []
            while j < n and src[j] != '"':
                if src[j] == '\\' and j + 1 < n:
                    s.append(src[j + 1]); j += 2; continue
                if src[j] == '\n': line += 1
                s.append(src[j]); j += 1
            toks.append(NS(t='str', v=''.join(s), line=start)); i = j + 1
            continue
        if c in '{}=':
            toks.append(NS(t=c, v=None, line=line)); i += 1; continue
        if c == '-' and src[i + 1:i + 2] == '>':
            toks.append(NS(t='->', v=None, line=line)); i += 2; continue
        m = _NUM.match(src[i:i + 20]) or _ID.match(src[i:i + 200])
        if m:
            toks.append(NS(t='id', v=m.group(0), line=line)); i += len(m.group(0)); continue
        toks.append(NS(t='?', v=c, line=line)); i += 1
    return toks


class Model:
    def __init__(self, name, elements, rels, errors):
        self.name, self.elements, self.rels, self.errors = name, elements, rels, errors
        self.rel_by_id = {r.id: r for r in rels}
        self.deployment = {'environments': []}

    def label(self, eid):
        parts, c = [], self.elements.get(eid)
        while c:
            parts.append(c.name)
            c = self.elements.get(c.parent) if c.parent else None
        return '/'.join(reversed(parts))

    def is_ancestor(self, a, child):
        c = self.elements.get(child)
        while c and c.parent:
            if c.parent == a: return True
            c = self.elements.get(c.parent)
        return False

    def loc_el(self, e):
        return {'kind': 'element', 'id': e.id, 'label': e.name, 'names': [e.name], 'line': e.line}

    def loc_rel(self, r):
        a, b = self.elements[r.src].name, self.elements[r.dst].name
        return {'kind': 'relationship', 'id': r.id, 'label': f'{a} → {b}', 'names': [a, b], 'line': r.line}


def _at(s, i):
    return s[i] if i < len(s) else None


def parse(src):
    toks = tokenize(src)
    st = {'p': 0, 'auto': 0, 'name': 'Untitled workspace'}
    errors, els, idents, pending, envs, inst_refs, dep_views = [], {}, {}, [], [], [], []
    cur = {'env': None}
    env_scopes = []

    def peek(k=0):
        i = st['p'] + k
        return toks[i] if i < len(toks) else None

    def nxt():
        i = st['p']; st['p'] += 1
        return toks[i] if i < len(toks) else None

    def err(tok, msg):
        line = tok.line if tok else (toks[-1].line if toks else 1)
        errors.append({'line': line, 'msg': msg})

    def add_tags(tags, s):
        for x in s.split(','):
            x = x.strip()
            if x: tags.add(x)

    def strings():
        out = []
        while peek() and peek().t == 'str': out.append(nxt().v)
        return out

    def skip_block():
        depth = 0
        while st['p'] < len(toks):
            t = nxt()
            if t.t == '{': depth += 1
            elif t.t == '}':
                depth -= 1
                if depth == 0: return

    def props(target):
        kw = nxt()
        if not peek() or peek().t != '{':
            err(kw, 'expected { after properties'); return
        nxt()
        while peek() and peek().t != '}':
            k, v = nxt(), peek()
            if not v or v.t == '}' or v.t not in ('str', 'id'):
                err(k, f'property "{k.v if k.v is not None else "undefined"}" has no value'); break
            nxt(); target[k.v] = v.v
        if peek(): nxt()
        else: err(kw, 'properties block is missing }')

    def element(kind_tok, ident, parent):
        kind = KINDS[kind_tok.v]; s = strings()
        if not ident: st['auto'] += 1
        eid = ident or f'_e{st["auto"]}'
        el = NS(id=eid, ident=ident, name=_at(s, 0) or '(unnamed)', kind=kind, tags={'Element'}, technology=None,
                description=_at(s, 1) or None, parent=parent, props={}, line=kind_tok.line)
        if kind in ('person', 'softwareSystem'):
            if _at(s, 2): add_tags(el.tags, s[2])
        else:
            el.technology = _at(s, 2) or None
            if _at(s, 3): add_tags(el.tags, s[3])
        if not _at(s, 0): err(kind_tok, f'{kind_tok.v} needs a name')
        if ident:
            if ident in idents: err(kind_tok, f'identifier "{ident}" is already used')
            idents[ident] = el.id
        els[el.id] = el
        if peek() and peek().t == '{':
            op = nxt()
            if not body(el): err(op, f'block for "{el.name}" is missing }}')

    def relationship(src_ref, arrow):
        dst = nxt()
        if not dst or dst.t != 'id':
            err(arrow, 'expected a destination after ->'); return
        s = strings()
        r = NS(src_ref=src_ref, dst_ref=dst.v, description=_at(s, 0) or '', technology=_at(s, 1) or None, props={}, line=arrow.line)
        if peek() and peek().t == '{':
            op = nxt()
            while peek() and peek().t != '}':
                t = peek()
                if t.t == 'id' and t.v == 'properties': props(r.props)
                elif t.t == '{': skip_block()
                else: nxt()
            if peek(): nxt()
            else: err(op, 'relationship block is missing }')
        pending.append(r)

    def deploy_body(lst, owner):
        while st['p'] < len(toks):
            t = peek()
            if t.t == '}':
                nxt(); return True
            if t.t == '{':
                skip_block(); continue
            if t.t == '->' and owner:
                nxt(); deploy_rel(owner, st_prev()); continue
            if t.t == '->':
                nxt()
                if peek() and peek().t == 'id': nxt()
                strings()
                if peek() and peek().t == '{': skip_block()
                continue
            if t.t != 'id':
                err(t, f'unexpected "{t.v or t.t}"'); nxt(); continue
            v, ident = t.v, None
            if peek(1) and peek(1).t == '=' and peek(2) and peek(2).t == 'id':
                ident = v; nxt(); nxt(); v = peek().v
            kw = peek()
            if owner and v == 'properties' and not ident:
                props(owner.props); continue
            if owner and v == 'tags' and not ident:
                nxt()
                for x in strings(): add_tags(owner.tags, x)
                continue
            if peek(1) and peek(1).t == '->' and not ident:
                nxt(); arrow = nxt(); deploy_rel(v, arrow); continue
            if v not in DEPLOY:
                nxt(); strings()
                if peek() and peek().t == '{': skip_block()
                else: err(kw, f'unknown keyword "{v}"')
                continue
            nxt()
            node = NS(kind=v, ident=ident, name='', description=None, technology=None, instances=None, tags=set(),
                      props={}, children=[], line=kw.line, ref=None, ref_name=None)
            if v in ('containerInstance', 'softwareSystemInstance'):
                ref = peek()
                if not ref or ref.t != 'id': err(kw, f'{v} needs an element')
                else:
                    nxt(); node.ref_name = ref.v; inst_refs.append(node)
                strings()
            else:
                s = strings()
                node.name = _at(s, 0) or ''; node.description = _at(s, 1) or None; node.technology = _at(s, 2) or None
                if not _at(s, 0): err(kw, f'{v} needs a name')
                if _at(s, 3): add_tags(node.tags, s[3])
                if v == 'deploymentNode':
                    if peek() and peek().t == 'id' and re.fullmatch(r'[0-9]+', peek().v): node.instances = nxt().v
                    elif _at(s, 4): node.instances = s[4]
            if peek() and peek().t == '{':
                op = nxt()
                if not deploy_body(node.children, node): err(op, f'block for "{node.name or node.ref_name}" is missing }}')
            lst.append(node)
            if ident: cur['env'].idents[ident] = node
        return False

    def st_prev():
        return toks[st['p'] - 1]

    def deploy_rel(src, arrow):
        dst = nxt().v if peek() and peek().t == 'id' else None
        s = strings()
        if peek() and peek().t == '{': skip_block()
        cur['env'].pending.append(NS(src=src, dst=dst, description=_at(s, 0) or None, technology=_at(s, 1) or None, line=arrow.line))

    def environment(ident):
        kw = nxt(); s = strings()
        env = NS(ident=ident, name=_at(s, 0) or '(unnamed)', nodes=[], rels=[], line=kw.line)
        cur['env'] = NS(env=env, idents={}, pending=[])
        if not _at(s, 0): err(kw, 'deploymentEnvironment needs a name')
        if peek() and peek().t == '{':
            op = nxt()
            if not deploy_body(env.nodes, None): err(op, f'block for "{env.name}" is missing }}')
        else: err(kw, f'deploymentEnvironment "{env.name}" needs a block')
        envs.append(env); env_scopes.append(cur['env']); cur['env'] = None

    def views_block():
        nxt()
        while st['p'] < len(toks):
            t = peek()
            if t.t == '}':
                nxt(); return
            if t.t == '{':
                skip_block(); continue
            nxt()
            if t.t != 'id' or t.v != 'deployment': continue
            head = []
            while peek() and peek().t not in ('{', '}') and len(head) < 6: head.append(nxt())
            if len(head) < 2:
                err(t, 'deployment view needs a scope and an environment'); continue
            dep_views.append(NS(scope=head[0].v, environment=head[1].v, key=head[2].v if len(head) > 2 and head[2].t == 'str' else None, line=t.line))

    def body(owner):
        while st['p'] < len(toks):
            t = peek()
            if t.t == '}':
                nxt(); return True
            if t.t == 'id':
                v = t.v
                if owner and v == 'properties':
                    props(owner.props); continue
                if owner and v == 'tags':
                    nxt()
                    for x in strings(): add_tags(owner.tags, x)
                    continue
                if owner and v in ('description', 'technology'):
                    nxt(); s = strings()
                    if _at(s, 0) is not None: setattr(owner, v, s[0])
                    continue
                if v == 'deploymentEnvironment':
                    environment(None); continue
                p1, p2 = peek(1), peek(2)
                if p1 and p1.t == '=' and p2 and p2.t == 'id' and p2.v == 'deploymentEnvironment':
                    nxt(); nxt(); environment(v); continue
                if p1 and p1.t == '=' and p2 and p2.t == 'id' and p2.v in KINDS:
                    nxt(); nxt(); k = nxt(); element(k, v, owner.id if owner else None); continue
                if v in KINDS:
                    nxt(); element(t, None, owner.id if owner else None); continue
                if p1 and p1.t == '->':
                    nxt(); a = nxt(); relationship(v, a); continue
                if v in ('workspace', 'model'):
                    nxt(); s = strings()
                    if v == 'workspace' and _at(s, 0): st['name'] = s[0]
                    if peek() and peek().t == '{':
                        op = nxt()
                        if not body(None): err(op, f'{v} block is missing }}')
                    continue
                if v == 'views' and p1 and p1.t == '{':
                    nxt(); views_block(); continue
                nxt(); strings()
                if peek() and peek().t == '{': skip_block()
                elif v not in SKIP and v != 'this': err(t, f'unknown keyword "{v}"')
                continue
            if t.t == '->' and owner:
                a = nxt(); relationship('#' + owner.id, a); continue
            if t.t == '{':
                skip_block(); continue
            err(t, f'unexpected "{t.v or t.t}"'); nxt()
        return False

    while st['p'] < len(toks):
        if body(None): err(toks[st['p'] - 1], 'unmatched }')

    def resolve(ref):
        return ref[1:] if ref.startswith('#') else idents.get(ref)

    rels = []
    for i, r in enumerate(pending):
        src, dst = resolve(r.src_ref), resolve(r.dst_ref)
        if not src:
            errors.append({'line': r.line, 'msg': f'unknown element "{r.src_ref}"'}); continue
        if not dst:
            errors.append({'line': r.line, 'msg': f'unknown element "{r.dst_ref}"'}); continue
        rels.append(NS(id=f'r{i + 1}', src=src, dst=dst, description=r.description, technology=r.technology, props=r.props, line=r.line))
    for n in inst_refs:
        rid = resolve(n.ref_name); el = els.get(rid) if rid else None
        if not el:
            errors.append({'line': n.line, 'msg': f'unknown element "{n.ref_name}"'}); n.name = n.ref_name; continue
        n.ref = el.id; n.name = el.name
    for sc in env_scopes:
        paths = {}
        def walk(nodes, prefix):
            for n in nodes:
                path = f'{prefix}/{n.name}' if prefix else n.name
                paths[id(n)] = path; walk(n.children, path)
        walk(sc.env.nodes, '')
        def path_of(ref):
            n = sc.idents.get(ref) if isinstance(ref, str) else ref
            return paths.get(id(n)) if n is not None else None
        for r in sc.pending:
            src = path_of(r.src); dst = None if r.dst is None else path_of(r.dst)
            if not src:
                errors.append({'line': r.line, 'msg': f'unknown deployment element "{r.src}"'}); continue
            if not dst:
                errors.append({'line': r.line, 'msg': f'unknown deployment element "{r.dst}"'}); continue
            sc.env.rels.append(NS(src=src, dst=dst, description=r.description, technology=r.technology, line=r.line))
    views = []
    for v in dep_views:
        env = next((e for e in envs if e.name == v.environment or (e.ident and e.ident == v.environment)), None)
        if not env:
            errors.append({'line': v.line, 'msg': f'deployment view names unknown environment "{v.environment}"'}); continue
        system = None
        if v.scope != '*':
            eid = idents.get(v.scope)
            el = els.get(eid) if eid else None
            if not el:
                errors.append({'line': v.line, 'msg': f'deployment view names unknown software system "{v.scope}"'}); continue
            if el.kind != 'softwareSystem':
                errors.append({'line': v.line, 'msg': 'deployment view scope must be a software system'}); continue
            system = el.id
        views.append(NS(scope=v.scope, environment=env.name, key=v.key, line=v.line, system=system))
    m = Model(st['name'], els, rels, errors)
    m.deployment = {'environments': envs, 'views': views}
    return m
