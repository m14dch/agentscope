#!/usr/bin/env python3
"""Validate the AgentScope YAML specifications.

Checks cross-references and invariants, expands variants and the Combined
composition, validates every MCP payload against the pinned revision's
schema.json, and recomputes all RAG reference results from the fixtures.

Usage:
    python3 specifications/tools/validate_specs.py --mcp-schema path/to/schema.json
    python3 specifications/tools/validate_specs.py --mcp-schema path/to/schema.json --dump-registry out.json

Download schema.json from the URL in 04-mcp-scenarios.yaml protocol.schema.
Requires PyYAML and jsonschema.
"""
import argparse
import copy
import json
import math
import re
import sys
from pathlib import Path

import jsonschema
import yaml

SPEC_DIR = Path(__file__).resolve().parent.parent
errors = []


def err(where, msg):
    errors.append(f"{where}: {msg}")


def load(name):
    return yaml.safe_load((SPEC_DIR / name).read_text())


# ---------------------------------------------------------------- expansion
def get_path(obj, path):
    for part in path.split("."):
        obj = obj[int(part)] if isinstance(obj, list) else obj[part]
    return obj


def set_path(obj, path, value):
    parts = path.split(".")
    for part in parts[:-1]:
        obj = obj[int(part)] if isinstance(obj, list) else obj[part]
    last = parts[-1]
    if isinstance(obj, list):
        obj[int(last)] = value
    else:
        obj[last] = value


def finalize(scn, sid, prefix):
    for i, e in enumerate(scn["events"], 1):
        e["scenario_id"] = sid
        e["sequence"] = i
        if prefix:
            e["id"] = f"{sid}:{e['id']}"
            if "pair_id" in e:
                e["pair_id"] = f"{sid}:{e['pair_id']}"
    scn["id"] = sid
    return scn


def parameter_problem(name, spec, value):
    """Parameter value rules (03 state_model.reducer_rules); mirrors src/scenarios/parameters.ts."""
    kind = lambda v: "boolean" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else type(v).__name__
    if kind(value) != kind(spec["default"]):
        return f"{name} must be a {kind(spec['default'])}, not {json.dumps(value)}"
    if "options" in spec and value not in spec["options"]:
        return f"{name} {json.dumps(value)} is not one of {', '.join(json.dumps(o) for o in spec['options'])}"
    if kind(value) == "number":
        if not math.isfinite(value):
            return f"{name} must be a finite number"
        if float(spec["default"]).is_integer() and not float(value).is_integer():
            return f"{name} must be a whole number"
        if not spec.get("min", value) <= value <= spec.get("max", value):
            return f"{name} {value} is outside {spec.get('min')}..{spec.get('max')}"
    return None


def expand_variant(base, var):
    scn = copy.deepcopy(base)
    events = scn["events"]

    def index(eid):
        for i, e in enumerate(events):
            if e["id"] == eid:
                return i
        raise KeyError(f"{var['id']}: unknown event {eid}")

    for op in var.get("operations", []):
        kind = op["op"]
        if kind == "patch":
            e = events[index(op["event"])]
            for path, value in op["set"].items():
                set_path(e, path, copy.deepcopy(value))
        elif kind == "replace":
            events[index(op["event"])] = copy.deepcopy(op["with"])
        elif kind == "remove":
            for eid in op["events"]:
                events.pop(index(eid))
        elif kind == "insert_after":
            i = index(op["event"]) + 1
            events[i:i] = copy.deepcopy(op["events"])
        else:
            err(var["id"], f"unknown operation {kind}")
    for name, value in var.get("parameter_overrides", {}).items():
        if name not in scn.get("parameters", {}):
            err(var["id"], f"parameter_overrides names unknown parameter {name}")
        else:
            spec = scn["parameters"][name]
            problem = parameter_problem(name, spec, value)
            if problem:
                err(var["id"], f"parameter_overrides {problem}")
            spec["default"] = copy.deepcopy(value)
    phases = {p["id"]: p for p in scn["phases"]}
    for pid, override in var.get("phase_overrides", {}).items():
        if pid not in phases:
            err(var["id"], f"phase_overrides names unknown phase {pid}")
        elif not str(override.get("takeaway", "")).strip():
            err(var["id"], f"phase_overrides {pid} has no takeaway")
        else:
            phases[pid]["takeaway"] = override["takeaway"]
    if "question" in var:
        scn["question"] = var["question"]
    scn["title"] = var["title"]
    if not str(var.get("lesson", "")).strip():
        err(var["id"], "variant has no lesson")
    scn["headline"] = var.get("lesson", "")  # a variant is presented by its lesson
    return finalize(scn, var["id"], True)


def compose(comp, registry):
    events = []
    for step in comp["compose"]:
        if "copy" in step:
            c = step["copy"]
            src = registry[c["scenario"]]["events"]
            ids = [e["id"] for e in src]
            part = copy.deepcopy(src[ids.index(c["from"]):ids.index(c["to"]) + 1])
            for e in part:
                e["phase"] = c.get("phase_map", {}).get(e["phase"], e["phase"])
                for path, value in c.get("patch", {}).get(e["id"], {}).items():
                    set_path(e, path, value)
            events += part
        else:
            events += copy.deepcopy(step["insert"])
    scn = {k: copy.deepcopy(comp[k]) for k in ("title", "question", "learning_question", "headline", "participants",
                                                "phases", "initial_state") if k in comp}
    scn["events"] = events
    return finalize(scn, comp["id"], True)


# ---------------------------------------------------------------- checks
MCP_REQ = {"server/discover": "DiscoverRequest", "tools/list": "ListToolsRequest", "tools/call": "CallToolRequest",
           "resources/list": "ListResourcesRequest", "resources/read": "ReadResourceRequest"}
MCP_RES = {"server/discover": "DiscoverResultResponse", "tools/list": "ListToolsResultResponse",
           "tools/call": "CallToolResultResponse", "resources/list": "ListResourcesResultResponse",
           "resources/read": "ReadResourceResultResponse"}


def check_scenario(scn, ctx):
    sid = scn["id"]
    events = scn["events"]
    by_id = {}
    for field in ctx["scenario_required"]:
        if field not in scn:
            err(sid, f"missing {field}")
    phases = {p["id"] for p in scn["phases"]}
    for field in ("learning_question", "headline"):
        if not str(scn.get(field, "")).strip():
            err(sid, f"missing {field}")
    if not str(scn.get("learning_question", "")).rstrip().endswith("?"):
        err(sid, "learning_question must end with '?'")
    for p in scn["phases"]:
        if not str(p.get("takeaway", "")).strip():
            err(sid, f"phase {p['id']} has no takeaway")
    for p in scn["phases"]:
        if p["semantic_phase"] not in ctx["semantic_phases"]:
            err(sid, f"phase {p['id']} has unknown semantic_phase {p['semantic_phase']}")
    for p in scn["participants"]:
        if p not in ctx["participants"]:
            err(sid, f"participant {p} missing from registry")
    for i, e in enumerate(events, 1):
        where = f"{sid}/{e.get('id')}"
        for f in ctx["required"]:
            if f not in e:
                err(where, f"missing {f}")
        for f, allowed in ctx["enums"].items():
            if e.get(f) not in allowed:
                err(where, f"{f} {e.get(f)} is not one of {' | '.join(allowed)}")
        if "correlation_id" in e and not (e["protocol"] == "MCP" and e["message_type"] in ("REQUEST", "RESPONSE")):
            err(where, "correlation_id outside an MCP request or response")
        if e["id"] in ctx["all_ids"]:
            err(where, "duplicate event id")
        ctx["all_ids"].add(e["id"])
        by_id[e["id"]] = e
        if e.get("sequence") != i or e.get("scenario_id") != sid:
            err(where, "bad sequence or scenario_id")
        if e["phase"] not in phases:
            err(where, f"unknown phase {e['phase']}")
        for p in (e["sender"], e["receiver"]):
            if p not in scn["participants"]:
                err(where, f"participant {p} not declared")
        if "prediction" in e:
            pred = e["prediction"]
            prompt = pred.get("prompt", "") if isinstance(pred, dict) else ""
            if not isinstance(prompt, str) or len(prompt.strip()) < 10 or not prompt.rstrip().endswith("?"):
                err(where, "prediction must be {prompt: <a question of at least 10 characters ending with '?'>}")
        if e["execution_type"] != "NETWORK" and "http" in e:
            err(where, "HTTP envelope on non-network event")
        if e["execution_type"] == "IN_PROCESS" and e["transport"] != "in_process":
            err(where, "IN_PROCESS event must use transport in_process")
        for b in e.get("security_boundaries", []):
            if b not in ctx["boundaries"]:
                err(where, f"unknown security boundary {b}")
        for k in e.get("tracked_values", {}):
            if k not in ctx["lineage"]:
                err(where, f"untracked lineage key {k}")
        for ch in e.get("state_changes", []):
            if ch.get("op") not in ("set", "append") or ("value" in ch) == ("value_ref" in ch):
                err(where, "state_change needs op set or append and exactly one of value and value_ref")
        for ch in e.get("context_changes", []):
            rule = {"agent_state": "append", "model_visible_messages": "set"}.get(ch.get("target"))
            if rule is None:
                err(where, f"context_change has unknown target {ch.get('target')}")
            elif ch.get("action") != rule:
                err(where, f"context_change on {ch.get('target')} must use action {rule}")
            if ch.get("target") == "model_visible_messages" and (
                    "value_ref" not in ch or e["protocol"] != "LLM_API" or e["message_type"] != "REQUEST"):
                err(where, "model_visible_messages changes only on LLM requests, with a value_ref")
        for ch in e.get("state_changes", []) + e.get("context_changes", []):
            if "value_ref" in ch:
                try:
                    get_path(e, ch["value_ref"])
                except (KeyError, IndexError, TypeError):
                    err(where, f"value_ref {ch['value_ref']} does not resolve")
    for e in events:
        where = f"{sid}/{e['id']}"
        if "pair_id" in e:
            other = by_id.get(e["pair_id"])
            if not other or other.get("pair_id") != e["id"]:
                err(where, f"pair {e['pair_id']} not reciprocal")
        if e["protocol"] == "MCP":
            check_mcp(e, by_id, ctx, where)
    check_visibility(scn)
    for k in ("question",):
        if k in scn and not isinstance(scn[k], str):
            err(sid, "question must be a string")


def check_mcp(e, by_id, ctx, where):
    p = e["payload"]
    if e["message_type"] == "REQUEST":
        method = p["method"]
        validate(p, MCP_REQ[method], ctx, where)
        h = e["http"]["headers"]
        if h.get("MCP-Protocol-Version") != p["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"]:
            err(where, "MCP-Protocol-Version header does not match _meta")
        if p["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"] != ctx["revision"]:
            err(where, "protocol version differs from pinned revision")
        if h.get("Mcp-Method") != method:
            err(where, "Mcp-Method header does not match method")
        if method in ("tools/call", "resources/read"):
            if h.get("Mcp-Name") != p["params"].get("name", p["params"].get("uri")):
                err(where, "Mcp-Name header does not match body")
        if e["correlation_id"] != str(p["id"]):
            err(where, "correlation_id differs from JSON-RPC id")
    elif e["message_type"] == "RESPONSE":
        req = by_id[e["pair_id"]]["payload"]
        if p["id"] != req["id"] or e["correlation_id"] != str(p["id"]):
            err(where, "JSON-RPC response id does not match request")
        validate(p, "JSONRPCErrorResponse" if "error" in p else MCP_RES[req["method"]], ctx, where)
        if "result" in p and req["method"] == "tools/call" and not p["result"]["isError"]:
            tool = next((t for t in ctx["tools"] if t["name"] == req["params"]["name"]), None)
            if tool and "outputSchema" in tool:
                jsonschema.validate(p["result"]["structuredContent"], tool["outputSchema"])


def validate(instance, definition, ctx, where):
    schema = {"$ref": f"#/$defs/{definition}", "$defs": ctx["schema"]["$defs"]}
    for e in jsonschema.Draft202012Validator(schema).iter_errors(instance):
        err(where, f"{definition}: {e.message} at {list(e.absolute_path)}")


def check_visibility(scn):
    """Tool results and retrieved chunks only reach the model through an LLM request, and every
    LLM request after a tool call carries the whole conversation."""
    results = {}
    tool_calls_seen = []
    for e in scn["events"]:
        where = f"{scn['id']}/{e['id']}"
        p = e.get("payload")
        if e["protocol"] == "LLM_API" and e["message_type"] == "RESPONSE":
            tool_calls_seen += [c["id"] for c in p["message"].get("tool_calls", [])]
        if e["protocol"] == "INTERNAL" and e["message_type"] == "RESULT" and isinstance(p, dict) and "content" in p:
            results[len(results)] = e["id"]
        if e["protocol"] == "LLM_API" and e["message_type"] == "REQUEST":
            msgs = p["messages"]
            tool_msgs = [m["tool_call_id"] for m in msgs if m["role"] == "tool"]
            calls = [c["id"] for m in msgs if m["role"] == "assistant" for c in m.get("tool_calls", [])]
            if tool_msgs != calls:
                err(where, "every assistant tool call needs its tool message")
            if tool_calls_seen and tool_msgs != tool_calls_seen:
                err(where, "LLM request does not resend the full conversation")
        for ch in e.get("context_changes", []):
            if ch["target"] == "model_visible_messages" and e["protocol"] != "LLM_API":
                err(where, "only LLM requests may change model-visible context")


# ---------------------------------------------------------------- RAG reference
def rag_engine(rag):
    fx = rag["fixtures"]
    emb = fx["embedding"]
    dims = emb["dimensions"]
    lex = {w: [g["weights"][d] for d in dims] for g in emb["lexicon"] for w in g["words"]}
    stop = set(fx["keyword_retrieval"]["stopwords"])

    def norm(t):
        return re.sub(r"^#+\s*", "", t, flags=re.M).replace("\n", " ")

    def toks(t):
        return re.findall(r"[a-z0-9]+", t.lower())

    def embed(t):
        v = [0.1] * len(dims)
        for w in toks(t):
            for i, x in enumerate(lex.get(w, [0] * len(dims))):
                v[i] += x
        n = math.sqrt(sum(x * x for x in v))
        return [round(x / n, 4) for x in v]

    def cos(a, b):
        return round(sum(x * y for x, y in zip(a, b)) / math.sqrt(sum(x * x for x in a)) / math.sqrt(sum(y * y for y in b)), 4)

    docs12 = {d["id"]: d for d in fx["documents"]}
    untrusted = {d["id"]: d for d in fx["untrusted_documents"]}

    def corpus(versions=("1.2",), extra=(), exclude=()):
        out = []
        for d in list(docs12.values()) + [untrusted[x] for x in extra]:
            if d["id"] in exclude:
                continue
            if d["id"] in untrusted:
                out.append((d["id"], d["version"], d["text"]))
                continue
            for v in versions:
                if v == d["version"]:
                    out.append((d["id"], v, d["text"]))
                else:
                    pv = next((p for p in fx["previous_versions"] if p["id"] == d["id"] and p["version"] == v), None)
                    if pv:
                        out.append((d["id"], v, d["text"].replace(pv["replace"]["from"], pv["replace"]["to"])))
        return out

    def chunks(docs, size, ov):
        out = []
        for doc, ver, text in docs:
            w = norm(text).split()
            i, n = 0, 1
            while True:
                t = " ".join(w[i:i + size])
                out.append({"id": f"{doc.rsplit('.', 1)[0]}@{ver}-c{size}o{ov}-{n:03d}", "documentId": doc,
                            "version": ver, "text": t, "embedding": embed(t)})
                if i + size >= len(w):
                    break
                i += size - ov
                n += 1
        return out

    params = next(sc for sc in rag["scenarios"] if sc["id"] == "rag-query")["parameters"]
    default_k = params["top_k"]["default"]
    default_thr = params["similarity_threshold"]["default"]

    def retrieve(docs, size=50, ov=10, top_k=None, thr=None, rerank=False):
        top_k = default_k if top_k is None else top_k
        thr = default_thr if thr is None else thr
        qv = embed(fx["query"])
        qt = sorted(set(toks(fx["query"])) - stop)
        cs = chunks(docs, size, ov)
        for c in cs:
            c["score"] = cos(qv, c["embedding"])
            ct = set(toks(c["text"]))
            c["keyword"] = round(sum(t in ct for t in qt) / len(qt), 4)
            c["rerank"] = round(0.7 * c["score"] + 0.3 * c["keyword"], 4)
        key = (lambda c: (-c["rerank"], c["id"])) if rerank else (lambda c: (-c["score"], c["id"]))
        ranked = sorted(cs, key=lambda c: (-c["score"], c["id"]))
        return qv, ranked, sorted([c for c in cs if c["score"] >= thr], key=key)[:top_k]

    facts = fx["answer_facts"]
    groups = fx["answer_groups"]
    injected = rag["variants"][-1]["untrusted_document_instruction"]

    def join(items):
        return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]

    def alone(pred):
        head, sep, tail = pred.rpartition(", ")
        return f"{head} and {tail}" if sep else pred

    def vkey(v):
        return tuple(int(x) for x in v.split("."))

    def answer(sel, intro=None):
        """Returns (answer text, cited chunks in citation order, supported fact ids)."""
        if not sel:
            return "I could not find sufficiently relevant information in the indexed documents to answer this question.", [], set()
        marked = {}

        def cite(c):  # placeholder; numbered by first appearance in the final text
            marked[c["id"]] = c
            return f"\x00{c['id']}\x00"

        official = [c for c in sel if c["documentId"] in docs12]
        parts, supported, missing = ([intro] if intro else []), set(), []
        for group in groups:
            runs, conflicts = [], []
            for f in [f for f in facts if f["group"] == group["id"]]:
                vals = {}
                for c in official:
                    ev = f["evidence"].get(c["version"], f["evidence"].get("*"))
                    if c["documentId"] == f["documentId"] and ev["span"] in c["text"]:
                        vals.setdefault(ev["predicate"], []).append(c)
                if not vals:
                    missing.append(f["aspect"])
                    continue
                supported.add(f["id"])
                if len(vals) == 1:
                    pred, cs = next(iter(vals.items()))
                    best = sorted(cs, key=lambda c: (tuple(-x for x in vkey(c["version"])), c["id"]))[0]
                    if runs and runs[-1][0] == f["subject"]:
                        runs[-1][1].append((pred, best))
                    else:
                        runs.append([f["subject"], [(pred, best)]])
                else:
                    ordered = sorted(vals.items(), key=lambda kv: vkey(kv[1][0]["version"]))
                    alts = "; ".join(f"version {cs[0]['version']}: {f['subject']} {alone(pred)} [{cite(cs[0])}]" for pred, cs in ordered)
                    conflicts.append(f"The indexed documents conflict on {f['aspect']} ({alts}); version "
                                     f"{ordered[-1][1][0]['version']} is the newest.")
            phrases = []
            for subject, preds in runs:
                items = []
                for i, (pred, c) in enumerate(preds):
                    last = i == len(preds) - 1 or preds[i + 1][1]["id"] != c["id"]
                    items.append(f"{pred} [{cite(c)}]" if last else pred)
                phrases.append(f"{subject} {join(items)}")
            if phrases:
                parts.append(f"{group['label']}: {'; '.join(phrases)}.")
            parts += conflicts
        if missing:
            parts.append(f"The retrieved evidence does not cover {join(missing)}.")
        if any(injected in c["text"] for c in sel):
            parts.append("Note: a retrieved document contained instructions addressed to the assistant; they were treated as data and ignored.")
        cites = []

        def number(m):
            c = marked[m.group(1)]
            if c not in cites:
                cites.append(c)
            return str(cites.index(c) + 1)
        return re.sub("\x00([^\x00]+)\x00", number, " ".join(parts)), cites, supported

    def source_lines(cites):
        return [f"[{i + 1}] {c['documentId']} v{c['version']}, chunk {c['id']}" for i, c in enumerate(cites)]

    def source_objects(cites):
        return [{"citation": i + 1, "chunkId": c["id"], "documentId": c["documentId"], "version": c["version"]}
                for i, c in enumerate(cites)]

    return {"corpus": corpus, "retrieve": retrieve, "answer": answer, "chunks": chunks,
            "source_lines": source_lines, "source_objects": source_objects, "default_k": default_k,
            "default_thr": default_thr, "params": params}


def corpus_kwargs(variant):
    """Translate a RAG variant's fixture_overrides into corpus() arguments."""
    fo = variant.get("fixture_overrides", {}) if variant else {}
    kw = {}
    versions = fo.get("indexed_versions")
    if versions:
        found = set()
        for v in versions.values():
            found.update(v if isinstance(v, list) else [v])
        kw["versions"] = tuple(sorted(found))
    if fo.get("add_documents"):
        kw["extra"] = tuple(fo["add_documents"])
    if fo.get("exclude_documents"):
        kw["exclude"] = tuple(fo["exclude_documents"])
    return kw


def check_rag(rag, comp, registry, ui):
    R = rag_engine(rag)
    refs = {k: v for k, v in rag["reference_results"].items() if k != "note"}
    variants = {v["id"]: v for v in rag["variants"]}
    p = R["params"]
    # UI controls (02) and scenario parameters (05) must agree.
    rc = ui["rag_controls"]
    if (rc["top_k"]["default"], rc["top_k"]["max"], rc["similarity_threshold"]["default"]) != \
            (p["top_k"]["default"], p["top_k"]["max"], p["similarity_threshold"]["default"]):
        err("02 rag_controls", "top_k or threshold defaults differ from 05 rag-query parameters")
    base_docs = R["corpus"]()
    for vid in variants:
        if vid not in refs:
            err(f"reference_results.{vid}", "missing for variant")
    for name, ref in refs.items():
        variant = variants.get(name)
        if not variant and not name.startswith("rag-query"):
            err(f"reference_results.{name}", "neither a variant nor a rag-query case")
            continue
        cited = [int(n) for n in re.findall(r"\[(\d+)\]", ref.get("answer", ""))]
        if list(dict.fromkeys(cited)) != list(range(1, len(set(cited)) + 1)):
            err(f"reference_results.{name}", "citations are not numbered by first appearance")
        rp = ref.get("parameters")
        if not isinstance(rp, dict):
            err(f"reference_results.{name}", "missing parameters")
            continue
        if variant:
            expected = {"chunk_size_words": 50, "overlap_words": 10, "top_k": R["default_k"],
                        "similarity_threshold": R["default_thr"]}
            po = variant.get("parameter_overrides", {})
            if "top_k" in po:
                expected["top_k"] = po["top_k"]
            if "similarity_threshold" in po:
                expected["similarity_threshold"] = po["similarity_threshold"]
            if po.get("rerank"):
                expected["rerank"] = True
            if rp != expected:
                err(f"reference_results.{name}", f"parameters {rp} differ from defaults plus overrides {expected}")
        docs = R["corpus"](**corpus_kwargs(variant))
        fo = (variant or {}).get("fixture_overrides", {})
        dropped = {d[0] for d in base_docs} - {d[0] for d in docs} - set(fo.get("exclude_documents", []))
        if dropped != set(fo.get("not_indexed", [])):
            err(f"reference_results.{name}", f"not_indexed {sorted(fo.get('not_indexed', []))} differs from the "
                f"documents missing from the index {sorted(dropped)}")
        qv, ranked, sel = R["retrieve"](docs, size=rp["chunk_size_words"], ov=rp["overlap_words"], top_k=rp["top_k"],
                                        thr=rp["similarity_threshold"], rerank=rp.get("rerank", False))
        got = [c["id"] for c in sel]
        want = [(s["chunkId"], s["score"], s.get("rerankScore")) for s in ref["selected"]]
        if [(c["id"], c["score"], c["rerank"] if rp.get("rerank") else None) for c in sel] != want:
            err(f"reference_results.{name}", f"selection or scores differ: {got}")
        a, cites, _ = R["answer"](sel)
        if a != ref["answer"] or R["source_lines"](cites) != ref["sources"]:
            err(f"reference_results.{name}", "answer or sources differ")
        if name == "rag-hybrid":
            terms = sorted(set(re.findall(r"[a-z0-9]+", rag["fixtures"]["query"].lower())) - set(rag["fixtures"]["keyword_retrieval"]["stopwords"]))
            hits = [{"chunkId": c["id"], "keywordScore": c["keyword"], "score": c["score"]}
                    for c in sorted(ranked, key=lambda c: c["id"]) if c["keyword"] > 0]
            if ref.get("keyword_query_terms") != terms or ref.get("keyword_hits") != hits:
                err("reference_results.rag-hybrid", "keyword terms or hits differ")
            ev = {e["id"]: e for e in registry["rag-hybrid"]["events"]}
            if ev.get("rag-hybrid:hybrid-02", {}).get("payload", {}).get("hits") != hits:
                err("rag-hybrid/hybrid-02", "keyword hits differ")
        if name == "rag-query":
            if qv != ref["query_embedding"]:
                err("reference_results.rag-query", "query embedding differs")
            if [(c["id"], c["score"], c["embedding"]) for c in ranked] != [(r["chunkId"], r["score"], r["embedding"]) for r in ref["ranking"]]:
                err("reference_results.rag-query", "ranking differs")
            ev = {e["id"]: e for e in registry["rag-query"]["events"]}
            if ev["retrieve-03"]["payload"]["embedding"] != qv:
                err("rag-query/retrieve-03", "query vector differs")
            if [(m["chunkId"], m["score"]) for m in ev["retrieve-05"]["payload"]["matches"]] != [(c["id"], c["score"]) for c in ranked]:
                err("rag-query/retrieve-05", "matches differ from computed ranking")
            discarded = [(d["chunkId"], d["score"]) for d in ev["retrieve-06"]["payload"]["discarded"]]
            if discarded != [(c["id"], c["score"]) for c in ranked if c["id"] not in got]:
                err("rag-query/retrieve-06", "discarded chunks differ")
            if ev["retrieve-06"]["payload"]["retained"] != got:
                err("rag-query/retrieve-06", "retained chunks differ")
            if ev["retrieve-11"]["payload"]["message"]["content"] != a + "\n\nSources:\n" + "\n".join(R["source_lines"](cites)):
                err("rag-query/retrieve-11", "model message differs from the composed answer and sources")
            if ev["retrieve-12"]["payload"]["answer"] != a or ev["retrieve-12"]["payload"]["sources"] != R["source_objects"](cites):
                err("rag-query/retrieve-12", "answer or sources differ")
            user = ev["retrieve-10"]["payload"]["messages"][1]["content"]
            for c in sel:
                if c["text"] not in user:
                    err("rag-query/retrieve-10", f"prompt lacks text of {c['id']}")
            idx = {e["id"]: e for e in registry["rag-index"]["events"]}
            stored = [(c["chunkId"], c["text"]) for c in idx["index-05"]["payload"]["chunks"]]
            all_chunks = R["chunks"](R["corpus"](), 50, 10)
            if stored != [(c["id"], c["text"]) for c in all_chunks]:
                err("rag-index/index-05", "chunks differ from computed chunks")
            if [x["embedding"] for x in idx["index-07"]["payload"]["embeddings"]] != [c["embedding"] for c in all_chunks]:
                err("rag-index/index-07", "vectors differ from computed vectors")

    # Combined: answer, sources and every derived payload.
    intro = "Your current balance is CHF 12,500.75 (source: get_customer_balance tool). You have an Everyday account."
    cases = [("combined", comp, comp)] + [(v["id"], v, comp) for v in comp.get("variants", [])]
    for label, case, base in cases:
        if not str(case.get("lesson" if case is not base else "headline", "")).strip():
            err(label, "missing lesson" if case is not base else "missing headline")
        _, ranked, sel = R["retrieve"](R["corpus"](**corpus_kwargs(case if case is not base else None)))
        a, cites, sup = R["answer"](sel, intro=intro)
        if {"everyday-fee", "everyday-access", "savings-fee-interest", "savings-access"} <= sup:
            a += (" Whether the Savings account would be better depends on how you use your money: it would avoid the "
                  "CHF 5 monthly fee and earn 0.50% annual interest, but it has no debit card, so it suits money you "
                  "rarely need rather than everyday card payments.")
        elif "savings-fee-interest" not in sup:
            a += " Without the Savings account terms I can't say whether another account type would offer better conditions."
        if a != case["expected_answer"] or R["source_lines"](cites) != case["expected_sources"]:
            err(label, "combined answer or sources differ from recomputation")
        if case is not base and case.get("expected_selected") != [c["id"] for c in sel]:
            err(label, "expected_selected differs from recomputation")
        if case is base:
            ev = {e["id"].split(":", 1)[1]: e for e in registry[comp["id"]]["events"]}
            for eid, e in ev.items():
                tracked = (e.get("tracked_values") or {}).get("chunkId")
                if tracked is not None and (tracked if isinstance(tracked, list) else [tracked])  not in ([c["id"] for c in sel], [c["id"] for c in ranked]):
                    err(f"{label}/{eid}", "tracked chunkId values are neither the ranking nor the retrieved chunks")
            if ev["c-03"]["payload"]["document_blocks"] != [c["id"] for c in sel]:
                err(label, "c-03 document blocks differ from the retrieved chunks")
            prompt = ev["c-04"]["payload"]["messages"][1]["content"]
            for c in sel:
                if c["text"] not in prompt:
                    err(label, f"c-04 prompt lacks text of {c['id']}")
            if ev["c-07"]["payload"]["message"]["content"] != a + "\n\nSources:\n" + "\n".join(R["source_lines"](cites)):
                err(label, "c-07 model message differs")
            if ev["c-08"]["payload"]["answer"] != a or ev["c-08"]["payload"]["sources"] != R["source_objects"](cites):
                err(label, "c-08 answer or sources differ")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mcp-schema", required=True, help="schema.json of the pinned MCP revision")
    ap.add_argument("--dump-registry", metavar="PATH", help="write the expanded registry as JSON (golden test)")
    args = ap.parse_args()
    product, arch, engine = load("00-product.yaml"), load("01-architecture.yaml"), load("03-simulation-engine.yaml")
    mcp, rag, cmp_ = load("04-mcp-scenarios.yaml"), load("05-rag-scenarios.yaml"), load("06-comparison-scenarios.yaml")
    sec = load("07-security-protocols.yaml")
    for name in sorted(p.name for p in SPEC_DIR.glob("*.yaml")):
        if load(name)["spec_version"] != product["spec_version"]:
            err(name, "spec_version differs from 00-product.yaml")
    if mcp["protocol"]["revision"] != sec["mcp"]["pinned_protocol_revision"]:
        err("04/07", "pinned MCP revision differs")
    ctx = {"schema": json.loads(Path(args.mcp_schema).read_text()), "revision": mcp["protocol"]["revision"],
           "participants": {p["id"] for p in arch["participants"]["registry"]},
           "boundaries": {b["id"] for b in sec["trust_boundaries"]},
           "semantic_phases": {p["id"] for p in cmp_["semantic_phases"]},
           "lineage": set(engine["lineage"]["tracked"]), "required": engine["event_schema"]["required"],
           "scenario_required": engine["scenario_format"]["required"],
           "enums": {f: engine["event_schema"]["fields"][f].split(" (")[0].split(" | ")
                     for f in ("protocol", "transport", "execution_type", "message_type")},
           "tools": next(e for e in mcp["scenarios"][0]["events"] if e["operation"] == "tools/list result")["payload"]["result"]["tools"],
           "all_ids": set()}
    if "DiscoverRequest" not in ctx["schema"].get("$defs", {}):
        err("--mcp-schema", "schema lacks DiscoverRequest; it is not revision 2026-07-28 or later")

    registry = {}
    for scn in mcp["scenarios"] + rag["scenarios"]:
        registry[scn["id"]] = scn
    for var in mcp["variants"] + rag["variants"]:
        registry[var["id"]] = expand_variant(registry[var["extends"]], var)
    comb = cmp_["combined"]
    registry[comb["id"]] = compose(comb, registry)
    if len(registry[comb["id"]]["events"]) != comb["expanded_event_count"]:
        err(comb["id"], "expanded_event_count differs")
    for scn in registry.values():
        check_scenario(scn, ctx)

    q = product["primary_questions"]
    if registry["mcp-balance"]["question"] != q["mcp"] or registry["rag-query"]["question"] != q["rag"] \
            or comb["question"] != q["combined"] or rag["fixtures"]["query"] != q["rag"]:
        err("primary_questions", "question strings differ")
    if cmp_["compare"]["left_question"] != q["rag"] or cmp_["compare"]["right_question"] != q["mcp"]:
        err("compare", "questions differ from primary_questions")
    for sid, mapping in cmp_["compare"]["phase_mapping"].items():
        if mapping != {p["id"]: p["semantic_phase"] for p in registry[sid]["phases"]}:
            err("compare.phase_mapping", f"{sid} mapping differs from scenario phases")
    final_mcp = registry["mcp-balance"]["events"][-1]["payload"]
    if "CHF 12,500.75" not in final_mcp:
        err("mcp-balance", "final answer lacks CHF 12,500.75")
    if not str(cmp_["compare"].get("headline", "")).strip():
        err("compare", "missing headline")
    check_rag(rag, comb, registry, load("02-ui-ux.yaml"))

    total = sum(len(s["events"]) for s in registry.values())
    if args.dump_registry:
        Path(args.dump_registry).write_text(json.dumps(registry, ensure_ascii=False, indent=1))
    if errors:
        print("\n".join(errors))
        print(f"\n{len(errors)} problem(s) in {len(registry)} expanded scenarios")
        return 1
    print(f"OK: {len(registry)} expanded scenarios, {total} events, all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
