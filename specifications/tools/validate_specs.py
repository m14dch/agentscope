#!/usr/bin/env python3
"""Validate the AgentScope YAML specifications.

Checks cross-references and invariants, expands the Combined composition,
validates every MCP payload against the pinned revision's
schema.json, and recomputes all RAG reference results from the fixtures.

Usage:
    python3 specifications/tools/validate_specs.py --mcp-schema path/to/schema.json
    python3 specifications/tools/validate_specs.py --mcp-schema path/to/schema.json --dump-registry out.json
    python3 specifications/tools/validate_specs.py --mcp-schema path/to/schema.json --dump-rag out.json

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


def finalize(scn, sid):
    for i, e in enumerate(scn["events"], 1):
        e["scenario_id"] = sid
        e["sequence"] = i
        e["id"] = f"{sid}:{e['id']}"
        if "pair_id" in e:
            e["pair_id"] = f"{sid}:{e['pair_id']}"
    scn["id"] = sid
    return scn


def compose(comp, registry):
    """The composed scenario (03 composition_format)."""
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
                                                "phases", "overview", "initial_state", "derived_events") if k in comp}
    scn["events"] = events
    return finalize(scn, comp["id"])


# ---------------------------------------------------------------- checks
MCP_REQ = {"server/discover": "DiscoverRequest", "tools/list": "ListToolsRequest", "tools/call": "CallToolRequest"}
MCP_RES = {"server/discover": "DiscoverResultResponse", "tools/list": "ListToolsResultResponse",
           "tools/call": "CallToolResultResponse"}


# ---------------------------------------------------------------- annotations
# 03 annotation_rules; mirrors src/scenarios/annotations.ts with the same messages.
ANNOTATED_PROTOCOLS = ("MCP", "LLM_API", "HTTP")
_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')
_PLAIN = re.compile(r"[^.\[\]]+")
_INDEX = re.compile(r"(0|[1-9][0-9]*)$")


def parse_path(path):
    """A JSON path ('$', 'a.b.0', 'a["x.y"].c') as its segments, or None."""
    if path == "$":
        return []
    out, rest, first = [], path, True
    while rest:
        if rest.startswith("["):
            m = _STRING.match(rest, 1)
            if not m or rest[m.end():m.end() + 1] != "]":
                return None
            out.append(json.loads(m.group(0)))
            rest = rest[m.end() + 1:]
        else:
            if not first:
                if not rest.startswith("."):
                    return None
                rest = rest[1:]
            m = _PLAIN.match(rest)
            if not m:
                return None
            out.append(m.group(0))
            rest = rest[m.end():]
        first = False
    return out or None


def format_path(segments):
    if not segments:
        return "$"
    out = ""
    for i, s in enumerate(segments):
        if not s or re.search(r'[.\[\]"]', s):
            out += "[" + json.dumps(s, ensure_ascii=False) + "]"
        else:
            out += ("." + s) if i else s
    return out


def resolve_path(value, segments):
    """(True, value) when the path exists, else (False, None)."""
    node = value
    for s in segments:
        if isinstance(node, list):
            if not _INDEX.match(s) or int(s) >= len(node):
                return False, None
            node = node[int(s)]
        elif isinstance(node, dict) and s in node:
            node = node[s]
        else:
            return False, None
    return True, node


def _starts_with(path, prefix):
    return len(prefix) <= len(path) and list(path[:len(prefix)]) == list(prefix)


def _members(value):
    if isinstance(value, list):
        return [(str(i), v) for i, v in enumerate(value)]
    if isinstance(value, dict):
        return list(value.items())
    return []


def _one_sentence(s):
    t = s.strip()
    return t.endswith(".") and not re.search(r"[.!?]\s+\S", t)


_GROUP_KEYS = ("heading", "sentence", "paths", "values")


def _document_order(payload, a, b):
    """Negative when path a comes before path b in the payload's text."""
    for i in range(min(len(a), len(b))):
        if a[i] == b[i]:
            continue
        keys = [k for k, _ in _members(resolve_path(payload, a[:i])[1])]
        return keys.index(a[i]) - keys.index(b[i])
    return len(a) - len(b)


def _q(text):
    return json.dumps(text, ensure_ascii=False)


def carries_problem(carries):
    ok = isinstance(carries, list) and carries and all(
        isinstance(c, str) and c.strip() and len(c) <= 100 and not c.rstrip().endswith(".") for c in carries)
    return None if ok else ("carries must be a non-empty list of phrases of at most 100 characters "
                            "without a final full stop")


def annotation_problems(payload, annotations):
    if not isinstance(annotations, list) or not annotations:
        return ["annotations must be a non-empty list of groups"]
    if payload is None:
        return ["annotations need a payload"]
    problems, paths = [], []
    for g, raw in enumerate(annotations):
        at = f"annotations[{g}]"
        if not isinstance(raw, dict):
            problems.append(f"{at} must be a group {{heading, sentence, paths, values}}")
            continue
        for key in raw:
            if key not in _GROUP_KEYS:
                problems.append(f"{at} has unknown key {_q(key)}")
        heading = raw.get("heading")
        if not isinstance(heading, str) or not heading.strip() or len(heading) > 40:
            problems.append(f"{at} heading must be a phrase of 1 to 40 characters")
        sentence = raw.get("sentence")
        if not isinstance(sentence, str) or not _one_sentence(sentence):
            problems.append(f"{at} sentence must be one sentence ending with a full stop")
        lst = raw.get("paths")
        if not isinstance(lst, list) or not lst or not all(isinstance(p, str) for p in lst):
            problems.append(f"{at} needs a non-empty list of paths")
            continue
        own = []
        for text in lst:
            segments = parse_path(text)
            if segments is None:
                problems.append(f"{at} path {_q(text)} is not a JSON path")
            elif not resolve_path(payload, segments)[0]:
                problems.append(f"{at} path {_q(text)} does not exist in the payload")
            else:
                paths.append((g, text, segments))
                own.append(segments)
        if "values" not in raw:
            continue
        values = raw["values"]
        if not isinstance(values, dict):
            problems.append(f"{at} values must map paths to meanings")
            continue
        previous = None
        for text, meaning in values.items():
            segments = parse_path(text)
            if segments is None:
                problems.append(f"{at} value path {_q(text)} is not a JSON path")
            elif not resolve_path(payload, segments)[0]:
                problems.append(f"{at} value path {_q(text)} does not exist in the payload")
            elif not any(_starts_with(segments, p) for p in own):
                problems.append(f"{at} value path {_q(text)} lies outside the group's paths")
            else:
                if previous is not None and _document_order(payload, previous, segments) > 0:
                    problems.append(f"{at} value path {_q(text)} comes before the value above it in the payload")
                previous = segments
            if not isinstance(meaning, str) or not meaning.strip():
                problems.append(f"{at} value {_q(text)} needs a meaning")
    for i, (ga, ta, sa) in enumerate(paths):
        for gb, tb, sb in paths[i + 1:]:
            if _starts_with(sa, sb) or _starts_with(sb, sa):
                problems.append(f"annotations[{ga}] path {_q(ta)} overlaps annotations[{gb}] path {_q(tb)}")
    if problems:
        return problems
    state = {"last": -1, "ordered": True}

    def walk(value, segments):
        held = next((p for p in paths if _starts_with(segments, p[2])), None)
        if held:
            if held[0] < state["last"] and state["ordered"]:
                state["ordered"] = False
                problems.append(f"annotations[{held[0]}] follows annotations[{state['last']}] in the payload: "
                                "groups must be in payload order")
            state["last"] = max(state["last"], held[0])
            return
        if not any(_starts_with(p[2], segments) for p in paths):
            problems.append(f"{format_path(segments)} lies under no group's path (a gap)")
            return
        for k, v in _members(value):
            walk(v, segments + [k])

    walk(payload, [])
    return problems


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
            if "value_ref" not in ch:
                err(where, "context_change needs a value_ref")
            if ch.get("target") == "model_visible_messages" and (
                    e["protocol"] != "LLM_API" or e["message_type"] != "REQUEST"):
                err(where, "model_visible_messages changes only on LLM requests")
        if "carries" in e and (problem := carries_problem(e["carries"])):
            err(where, problem)
        if "annotations" in e:
            for problem in annotation_problems(e.get("payload"), e["annotations"]):
                err(where, problem)
        if e["protocol"] in ANNOTATED_PROTOCOLS:
            if "carries" not in e:
                err(where, "missing carries")
            if isinstance(e.get("payload"), (dict, list)) and "annotations" not in e:
                err(where, "missing annotations")
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
    check_derived(scn, by_id)
    check_overview(scn)
    for k in ("question",):
        if k in scn and not isinstance(scn[k], str):
            err(sid, "question must be a string")


# Words a first-time visitor would have to look up (03 overview_fields.plain_words).
JARGON = re.compile(r"\b(mcp\w*|https?|json\w*|rpcs?|llms?|apis?|tools?|servers?|vectors?|embed\w*"
                    r"|chunk\w*|prompts?|tokens?|schemas?|models?)\b", re.I | re.A)
REST = re.compile(r"\bREST\b")


def jargon(text):
    """The first technical word in text, or None (03 overview_fields.plain_words)."""
    m = JARGON.search(text) or REST.search(text)
    return m.group(0) if m else None


def one_sentence(text):
    """One plain sentence: it ends with a period and holds no other sentence end."""
    body = text.strip()
    return bool(body) and body.endswith(".") and not re.search(r"[.?!]\s", body[:-1]) \
        and not re.search(r"[?!]", body)


def check_overview(scn):
    """The Overview zoom level (03 scenario_format.overview_fields); mirrored in validate.ts."""
    sid = scn["id"]
    ov = scn.get("overview")
    if not isinstance(ov, dict):
        err(sid, "overview must be {parties, stages}")
        return
    parties = ov.get("parties") if isinstance(ov.get("parties"), list) else []
    stages = ov.get("stages") if isinstance(ov.get("stages"), list) else []
    if not 2 <= len(parties) <= 4:
        err(sid, "overview needs 2 to 4 parties")
    if not 3 <= len(stages) <= 5:
        err(sid, "overview needs 3 to 5 stages")
    ids = set()
    members = []
    for i, party in enumerate(parties):
        party = party if isinstance(party, dict) else {}
        pid = party.get("id") if isinstance(party.get("id"), str) else ""
        label = party.get("label")
        if not pid or pid in ids:
            err(sid, f"overview party {i} needs a unique id")
        ids.add(pid)
        if not isinstance(label, str) or not label.strip():
            err(sid, f"overview party {pid} needs a label")
        elif jargon(label):
            err(sid, f"overview party {pid} uses the technical word {jargon(label)}")
        group = party.get("members")
        if not isinstance(group, list) or not group:
            err(sid, f"overview party {pid} needs members")
            group = []
        members += [m if isinstance(m, str) else "" for m in group]
    if sorted(members) != sorted(scn["participants"]):
        err(sid, "overview parties must partition the participants")
    covered = []
    stage_ids = set()
    stage_of = {}
    for i, stage in enumerate(stages):
        stage = stage if isinstance(stage, dict) else {}
        tid = stage.get("id") if isinstance(stage.get("id"), str) else ""
        sentence = stage.get("sentence")
        if not tid or tid in stage_ids:
            err(sid, f"overview stage {i} needs a unique id")
        stage_ids.add(tid)
        if not isinstance(sentence, str) or not one_sentence(sentence):
            err(sid, f"overview stage {tid} needs one sentence ending with a period")
        elif jargon(sentence):
            err(sid, f"overview stage {tid} uses the technical word {jargon(sentence)}")
        phases = stage.get("phases")
        if not isinstance(phases, list) or not phases:
            err(sid, f"overview stage {tid} needs phases")
            phases = []
        for ph in phases:
            name = ph if isinstance(ph, str) else ""
            covered.append(name)
            stage_of[name] = i
    if covered != [p["id"] for p in scn["phases"]]:
        err(sid, "overview stages must partition the phases in their order")
        return
    last = 0
    for e in scn["events"]:
        at = stage_of.get(e.get("phase"), last)
        if at < last:
            err(f"{sid}/{e['id']}", "events must visit the overview stages in order")
            return
        last = at


def check_derived(scn, by_id):
    """derived_events and optional_steps name the scenario's events (03 scenario_format.optional_fields)."""
    sid = scn["id"]
    local = {eid.split(":", 1)[1] if eid.startswith(f"{sid}:") else eid for eid in by_id}
    for eid in scn.get("derived_events", []):
        if eid not in local:
            err(sid, f"derived_events names unknown event {eid}")
    steps = scn.get("optional_steps", [])
    if not isinstance(steps, list):
        err(sid, "optional_steps must be a list")
        return
    for step in steps:
        param = scn.get("parameters", {}).get(step.get("enabled_by"))
        if not param or not isinstance(param.get("default"), bool):
            err(sid, f"optional step enabled_by {step.get('enabled_by')} is not a boolean parameter")
        for eid in step.get("events", []):
            if eid not in local:
                err(sid, f"optional_steps names unknown event {eid}")
                continue
            pair = by_id.get(eid if eid in by_id else f"{sid}:{eid}", {}).get("pair_id")
            if pair is not None and pair.split(":", 1)[-1] not in step.get("events", []):
                err(sid, f"optional step {eid} and its pair {pair.split(':', 1)[-1]} are in different entries")


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
        if method == "tools/call":
            if h.get("Mcp-Name") != p["params"]["name"]:
                err(where, "Mcp-Name header does not match body")
        if e["correlation_id"] != str(p["id"]):
            err(where, "correlation_id differs from JSON-RPC id")
    elif e["message_type"] == "RESPONSE":
        req = by_id[e["pair_id"]]["payload"]
        if p["id"] != req["id"] or e["correlation_id"] != str(p["id"]):
            err(where, "JSON-RPC response id does not match request")
        validate(p, MCP_RES[req["method"]], ctx, where)
        if req["method"] == "tools/call":
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

    def corpus():
        """The indexed documents (05 derived_event_rules.inputs): (ID, version, text)."""
        return [(d["id"], d["version"], d["text"]) for d in fx["documents"]]

    def chunks(docs, size, ov):
        out = []
        for doc, ver, text in docs:
            w = norm(text).split()
            i, n = 0, 1
            while True:
                t = " ".join(w[i:i + size])
                out.append({"id": f"{doc.rsplit('.', 1)[0]}@{ver}-c{size}o{ov}-{n:03d}", "documentId": doc,
                            "version": ver, "startWord": i, "text": t, "embedding": embed(t)})
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

    def join(items):
        return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]

    def answer(sel, intro=None):
        """Returns (answer text, cited chunks in citation order, supported fact ids)."""
        parts, cites, supported = answer_parts(sel, intro)
        return " ".join(p["text"] for p in parts), cites, supported

    def answer_parts(sel, intro=None):
        """answer_rules' parts in order, each {kind, text} (intro parts also carry their source);
        the answer is their texts joined by single spaces. Returns (parts, cites, supported)."""
        if not sel:
            return [{"kind": "no-evidence", "text": "I could not find sufficiently relevant information in the "
                     "indexed documents to answer this question."}], [], set()
        marked = {}

        def cite(c):  # placeholder; numbered by first appearance in the final text
            marked[c["id"]] = c
            return f"\x00{c['id']}\x00"

        parts = [{"kind": "intro", "source": p["source"], "text": p["text"]} for p in intro or []]
        supported, missing = set(), []
        for group in groups:
            runs = []
            for f in [f for f in facts if f["group"] == group["id"]]:
                vals = {}
                for c in sel:
                    ev = f["evidence"].get(c["version"], f["evidence"].get("*"))
                    if c["documentId"] == f["documentId"] and ev["span"] in c["text"]:
                        vals.setdefault(ev["predicate"], []).append(c)
                if not vals:
                    missing.append(f["aspect"])
                    continue
                supported.add(f["id"])
                # One version per document, so one predicate; several chunks: the lowest ID.
                (pred, cs), = vals.items()
                best = min(cs, key=lambda c: c["id"])
                if runs and runs[-1][0] == f["subject"]:
                    runs[-1][1].append((pred, best))
                else:
                    runs.append([f["subject"], [(pred, best)]])
            phrases = []
            for subject, preds in runs:
                items = []
                for i, (pred, c) in enumerate(preds):
                    last = i == len(preds) - 1 or preds[i + 1][1]["id"] != c["id"]
                    items.append(f"{pred} [{cite(c)}]" if last else pred)
                phrases.append(f"{subject} {join(items)}")
            if phrases:
                parts.append({"kind": "group", "text": f"{group['label']}: {'; '.join(phrases)}."})
        if missing:
            parts.append({"kind": "gap", "text": f"The retrieved evidence does not cover {join(missing)}."})
        cites = []

        def number(m):
            c = marked[m.group(1)]
            if c not in cites:
                cites.append(c)
            return str(cites.index(c) + 1)
        # Numbered part by part in order, which numbers them as the joined text would.
        for p in parts:
            p["text"] = re.sub("\x00([^\x00]+)\x00", number, p["text"])
        return parts, cites, supported

    def parents(sel, docs):
        """The parent documents of the retained chunks (derived_event_rules.evidence)."""
        out = []
        for c in sel:
            key = (c["documentId"], c["version"])
            if any((p["documentId"], p["version"]) == key for p in out):
                continue
            text = next(t for d, v, t in docs if (d, v) == key)
            out.append({"id": f"{c['documentId'].rsplit('.', 1)[0]}@{c['version']}", "documentId": c["documentId"],
                        "version": c["version"], "text": " ".join(norm(text).split()), "document": True})
        return out

    def source_lines(cites):
        return [f"[{i + 1}] {c['documentId']} v{c['version']}, "
                + ("full document" if c.get("document") else f"chunk {c['id']}") for i, c in enumerate(cites)]

    def source_objects(cites):
        return [{"citation": i + 1, **({} if c.get("document") else {"chunkId": c["id"]}),
                 "documentId": c["documentId"], "version": c["version"]} for i, c in enumerate(cites)]

    return {"corpus": corpus, "retrieve": retrieve, "answer": answer, "answer_parts": answer_parts, "chunks": chunks, "parents": parents,
            "norm": norm, "toks": toks, "source_lines": source_lines, "source_objects": source_objects,
            "default_k": default_k, "default_thr": default_thr, "params": params}


def threshold_text(x):
    """Thresholds in explanations are rounded to 2 decimals (05 derived_event_rules.inputs)."""
    r = round(float(x), 2)
    # Like the TypeScript String(Number(x.toFixed(2))): 0 and 1 print without '.0'.
    return str(int(r)) if r == int(r) else str(r)


def user_message(question, evidence, trust_of):
    """retrieve-10's user message (05 derived_event_rules.retrieve-10)."""
    def block(c):
        trust = trust_of[c["documentId"]]
        chunk = "" if c.get("document") else f' chunk="{c["id"]}"'
        return f'<document id="{c["documentId"]}" version="{c["version"]}"{chunk} trust="{trust}">\n{c["text"]}\n</document>'
    blocks = "\n".join(block(c) for c in evidence) if evidence else "(none)"
    return f"Question: {question}\n\nRetrieved documents:\n{blocks}"


def check_derived_defaults(R, rag, registry, ranked, sel):
    """Every derived event of rag-index and rag-query at the default parameters; an optional step
    with its enabling parameter on (05 derived_event_rules)."""
    fx = rag["fixtures"]
    trust_of = {d["id"]: d["trust"] for d in fx["documents"]}
    chunking = next(sc for sc in rag["scenarios"] if sc["id"] == "rag-index")["parameters"]
    size, ov = chunking["chunk_size_words"]["default"], chunking["overlap_words"]["default"]
    docs = R["corpus"]()
    all_chunks = R["chunks"](docs, size, ov)
    ids = [c["id"] for c in all_chunks]
    # rag-query searches this chunking; its projection gives every point its own label (02).
    if len({tuple(c["embedding"]) for c in all_chunks}) != len(all_chunks):
        err("rag-index", "two chunks share a vector at the default chunking")

    def expect(where, got, want):
        if got != want:
            err(where, f"{got!r} differs from the derivation {want!r}")

    idx = {e["id"]: e for e in registry["rag-index"]["events"]}
    expect("rag-index/index-04", {k: idx["index-04"]["payload"][k] for k in ("chunk_size_words", "overlap_words")},
           {"chunk_size_words": size, "overlap_words": ov})
    expect("rag-index/index-05", idx["index-05"]["payload"]["chunks"],
           [{"chunkId": c["id"], "documentId": c["documentId"], "version": c["version"],
             "startWord": c["startWord"], "text": c["text"]} for c in all_chunks])
    expect("rag-index/index-05", idx["index-05"]["explanation"],
           f"{len(all_chunks)} chunks, each pointing back to its source document.")
    expect("rag-index/index-05", idx["index-05"]["tracked_values"]["chunkId"], ids)
    expect("rag-index/index-06", idx["index-06"]["payload"]["inputs"], ids)
    expect("rag-index/index-07", idx["index-07"]["payload"]["embeddings"],
           [{"chunkId": c["id"], "embedding": c["embedding"]} for c in all_chunks])
    expect("rag-index/index-08", idx["index-08"]["payload"]["records"], len(ids))
    expect("rag-index/index-09", idx["index-09"]["payload"]["upserted"], len(ids))
    expect("rag-index/index-10", (idx["index-10"]["payload"]["documents"], idx["index-10"]["payload"]["chunks"]),
           (len({d for d, _, _ in docs}), len(ids)))

    scn = registry["rag-query"]
    ev = {e["id"]: e for e in scn["events"]}
    params = {k: p["default"] for k, p in scn["parameters"].items()}
    thr, k = params["similarity_threshold"], params["top_k"]
    got = [c["id"] for c in sel]
    sel_docs = sorted({c["documentId"] for c in sel})
    expect("rag-query/retrieve-05", ev["retrieve-05"]["payload"]["matches"],
           [{"chunkId": c["id"], "documentId": c["documentId"], "version": c["version"], "score": c["score"]}
            for c in ranked])
    expect("rag-query/retrieve-05", ev["retrieve-05"]["tracked_values"]["chunkId"], [c["id"] for c in ranked])
    # hybrid-02 with keyword_retrieval on, hybrid-03 with rerank on.
    hits = sorted([c for c in ranked if c["keyword"] > 0], key=lambda c: c["id"])
    expect("rag-query/hybrid-02", ev["hybrid-02"]["payload"]["hits"],
           [{"chunkId": c["id"], "keywordScore": c["keyword"], "score": c["score"]} for c in hits])
    below = sorted([c for c in hits if c["score"] < thr], key=lambda c: (c["score"], c["id"]))
    if not hits:
        text = "No chunk contains a query term."
    elif not below:
        text = f"Exact-term hits. All of them reach the similarity threshold of {threshold_text(thr)}."
    else:
        present = set(R["toks"](below[0]["text"]))
        terms = [f"'{t}'" for t in sorted(set(R["toks"](fx["query"])) - set(fx["keyword_retrieval"]["stopwords"]))
                 if t in present]
        terms = terms[0] if len(terms) == 1 else ", ".join(terms[:-1]) + " and " + terms[-1]
        if len(below) == 1:
            text = (f"Exact-term hits. One hit scores below the similarity threshold of {threshold_text(thr)}: "
                    f"{below[0]['id']}, a lexical false positive that matches only {terms} and that the "
                    "threshold later removes.")
        else:
            text = (f"Exact-term hits. {len(below)} hits score below the similarity threshold of {threshold_text(thr)}: "
                    f"lexical false positives that the threshold later removes, such as {below[0]['id']}, which "
                    f"matches only {terms}.")
    expect("rag-query/hybrid-02", ev["hybrid-02"]["explanation"], text)
    above = sorted([c for c in ranked if c["score"] >= thr], key=lambda c: (-c["rerank"], c["id"]))
    expect("rag-query/hybrid-03", ev["hybrid-03"]["payload"]["candidates"],
           [{"chunkId": c["id"], "score": c["score"], "keywordScore": c["keyword"], "rerankScore": c["rerank"]}
            for c in above])
    expect("rag-query/hybrid-03", ev["hybrid-03"]["explanation"],
           "Drop chunks below the similarity threshold, then order by the reranker score, which also counts "
           "the query terms in each chunk.")
    expect("rag-query/retrieve-06", ev["retrieve-06"]["payload"],
           {"top_k": k, "similarity_threshold": thr, "rerank": params["rerank"], "retained": got,
            "discarded": [{"chunkId": c["id"], "score": c["score"],
                           "reason": "below threshold" if c["score"] < thr else "outside topK"}
                          for c in ranked if c["id"] not in got]})
    best = "the best one" if k == 1 else f"the {k} best"
    expect("rag-query/retrieve-06", ev["retrieve-06"]["explanation"],
           f"Keep chunks with a score of at least {threshold_text(thr)}, then {best}. Ties are broken by chunk ID."
           + ("" if sel else f" No chunk reaches {threshold_text(thr)}, so nothing is retained."))
    expect("rag-query/retrieve-06", ev["retrieve-06"]["tracked_values"], {"chunkId": got})
    # retrieve-07 and retrieve-08 with fetch_full_documents on.
    parents = R["parents"](sel, docs)
    expect("rag-query/retrieve-07", ev["retrieve-07"]["payload"]["documents"],
           [{"documentId": p["documentId"], "version": p["version"]} for p in parents])
    expect("rag-query/retrieve-08", ev["retrieve-08"]["payload"]["documents"],
           [{"documentId": p["documentId"], "version": p["version"], "words": len(p["text"].split()),
             "text": p["text"]} for p in parents])
    tracked = {"sourceDocumentId": sel_docs, "chunkId": got, "retrievedText": [c["text"] for c in sel]}
    after = ev["retrieve-09"]["payload"]["prompt_after"]
    expect("rag-query/retrieve-09", after["document_blocks"],
           [{"chunkId": c["id"], "trust": trust_of[c["documentId"]]} for c in sel])
    expect("rag-query/retrieve-09", ev["retrieve-09"]["tracked_values"], tracked)
    if after["system"].count("document ID, version and chunk ID") != 1 or "document ID and version" in after["system"]:
        err("rag-query/retrieve-09", "prompt_after.system must ask for chunk citations ('document ID, version "
            "and chunk ID') exactly once at the default parameters")
    messages = ev["retrieve-10"]["payload"]["messages"]
    expect("rag-query/retrieve-10", messages[0]["content"], after["system"])
    expect("rag-query/retrieve-10", messages[1]["content"], user_message(scn["question"], sel, trust_of))
    expect("rag-query/retrieve-10", ev["retrieve-10"]["tracked_values"], tracked)
    for eid in ("retrieve-11", "retrieve-12"):
        expect(f"rag-query/{eid}", ev[eid]["tracked_values"], {"sourceDocumentId": sel_docs, "chunkId": got})


def default_played_phases(scn):
    """Scenario phase IDs with an event played at the default parameters (03 optional_steps)."""
    params = scn.get("parameters") or {}
    off = {eid for step in scn.get("optional_steps") or []
           if (params.get(step.get("enabled_by")) or {}).get("default") is not True
           for eid in step.get("events", [])}
    prefix = f"{scn['id']}:"
    return {e["phase"] for e in scn["events"]
            if (e["id"][len(prefix):] if e["id"].startswith(prefix) else e["id"]) not in off}


def check_compare(cmp_, registry):
    """Placeholders and aspects of the Compare view (02 compare_view); mirrored in validate.ts."""
    compare = cmp_["compare"]
    semantic = [p["id"] for p in cmp_["semantic_phases"]]
    mappings = compare.get("phase_mapping") or {}
    placeholders = compare.get("placeholders", {})
    if not isinstance(placeholders, dict):
        err("compare.placeholders", "must map scenario IDs to placeholders")
        placeholders = {}
    for sid in placeholders:
        if sid not in mappings:
            err("compare.placeholders", f"{sid} is not in phase_mapping")
    for sid, mapping in mappings.items():
        scn = registry.get(sid)
        if scn is None:
            continue
        # A pane with no events in a semantic phase shows a placeholder (02 compare_view.timeline).
        played = {mapping.get(p) for p in default_played_phases(scn)}
        missing = [p for p in semantic if p not in played]
        given = placeholders.get(sid, {})
        if not isinstance(given, dict) or sorted(given) != sorted(missing):
            err("compare.placeholders", f"{sid} placeholders must cover exactly: {', '.join(missing)}")
            continue
        for phase, text in given.items():
            if not isinstance(text, str) or not text.strip():
                err("compare.placeholders", f"{sid} placeholder for {phase} is empty")
    headline = compare.get("overview_headline")
    if not isinstance(headline, str) or not one_sentence(headline):
        err("compare.overview_headline", "needs one sentence ending with a period")
    elif jargon(headline):
        err("compare.overview_headline", f"uses the technical word {jargon(headline)}")
    aspects = compare.get("aspects")
    if not isinstance(aspects, list) or not aspects:
        err("compare.aspects", "needs at least one aspect")
        return
    for i, a in enumerate(aspects):
        if not isinstance(a, dict) or set(a) != {"label", "sentence"} \
                or not all(isinstance(v, str) and v.strip() for v in a.values()):
            err("compare.aspects", f"aspect {i} needs exactly a label and a sentence")


def answer_composition_problem(composition):
    """What is wrong with an answer_composition (06 combined), or None. Mirrors
    answerCompositionProblem in src/rag/derive.ts, message for message."""
    def is_text(v):
        return isinstance(v, str) and v.strip() != ""
    if not isinstance(composition, dict):
        return "missing"
    intro = composition.get("intro")
    if not isinstance(intro, list) or not intro or any(
            not isinstance(p, dict) or p.get("source") not in ("tool", "session") or not is_text(p.get("text"))
            for p in intro):
        return "intro must list sentences, each with source tool or session and a text"
    comparisons = composition.get("comparisons")
    if not isinstance(comparisons, list) or any(
            not isinstance(c, dict) or not is_text(c.get("sentence")) or not is_text(c.get("explanation"))
            for c in comparisons):
        return "each comparison needs a sentence and an explanation"
    if not is_text(composition.get("explanation")):
        return "explanation is missing"
    return None


def check_rag(rag, comp, registry, ui):
    R = rag_engine(rag)
    refs = {k: v for k, v in rag["reference_results"].items() if k != "note"}
    p = R["params"]
    # UI controls (02) and scenario parameters (05) must agree.
    rc = ui["rag_controls"]
    if (rc["top_k"]["default"], rc["top_k"]["max"], rc["similarity_threshold"]["default"]) != \
            (p["top_k"]["default"], p["top_k"]["max"], p["similarity_threshold"]["default"]):
        err("02 rag_controls", "top_k or threshold defaults differ from 05 rag-query parameters")
    chunking = next(sc for sc in rag["scenarios"] if sc["id"] == "rag-index")["parameters"]
    for name in ("chunk_size_words", "overlap_words"):
        if (rc[name]["options"], rc[name]["default"]) != (chunking[name]["options"], chunking[name]["default"]):
            err(f"02 rag_controls.{name}", "options or default differ from 05 rag-index parameters")
    docs = R["corpus"]()
    for name, ref in refs.items():
        if not name.startswith("rag-query"):
            err(f"reference_results.{name}", "not a rag-query case")
            continue
        cited = [int(n) for n in re.findall(r"\[(\d+)\]", ref.get("answer", ""))]
        if list(dict.fromkeys(cited)) != list(range(1, len(set(cited)) + 1)):
            err(f"reference_results.{name}", "citations are not numbered by first appearance")
        rp = ref.get("parameters")
        if not isinstance(rp, dict):
            err(f"reference_results.{name}", "missing parameters")
            continue
        qv, ranked, sel = R["retrieve"](docs, size=rp["chunk_size_words"], ov=rp["overlap_words"], top_k=rp["top_k"],
                                        thr=rp["similarity_threshold"], rerank=rp.get("rerank", False))
        got = [c["id"] for c in sel]
        want = [(s["chunkId"], s["score"], s.get("rerankScore")) for s in ref["selected"]]
        if [(c["id"], c["score"], c["rerank"] if rp.get("rerank") else None) for c in sel] != want:
            err(f"reference_results.{name}", f"selection or scores differ: {got}")
        a, cites, _ = R["answer"](sel)
        if a != ref["answer"] or R["source_lines"](cites) != ref["sources"]:
            err(f"reference_results.{name}", "answer or sources differ")
        if "keyword_query_terms" in ref or "keyword_hits" in ref:
            terms = sorted(set(R["toks"](rag["fixtures"]["query"])) - set(rag["fixtures"]["keyword_retrieval"]["stopwords"]))
            hits = [{"chunkId": c["id"], "keywordScore": c["keyword"], "score": c["score"]}
                    for c in sorted(ranked, key=lambda c: c["id"]) if c["keyword"] > 0]
            if ref.get("keyword_query_terms") != terms or ref.get("keyword_hits") != hits:
                err(f"reference_results.{name}", "keyword terms or hits differ")
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
            check_derived_defaults(R, rag, registry, ranked, sel)

    # Combined: answer, sources and every derived payload.
    composition = comp.get("answer_composition")
    problem = answer_composition_problem(composition)
    if problem:
        err("combined.answer_composition", problem)
        return
    intro = composition["intro"]
    if not str(comp.get("headline", "")).strip():
        err("combined", "missing headline")
    _, ranked, sel = R["retrieve"](docs)
    parts, cites, sup = R["answer_parts"](sel, intro=intro)
    applies = next((c for c in composition["comparisons"] if set(c.get("requires", [])) <= sup), None)
    if applies:
        parts.append({"kind": "comparison", "text": applies["sentence"]})
    a = " ".join(p["text"] for p in parts)
    if a != comp["expected_answer"] or R["source_lines"](cites) != comp["expected_sources"]:
        err("combined", "combined answer or sources differ from recomputation")
    ev = {e["id"].split(":", 1)[1]: e for e in registry[comp["id"]]["events"]}
    for eid, e in ev.items():
        tracked = (e.get("tracked_values") or {}).get("chunkId")
        if tracked is not None and (tracked if isinstance(tracked, list) else [tracked]) not in ([c["id"] for c in sel], [c["id"] for c in ranked]):
            err(f"combined/{eid}", "tracked chunkId values are neither the ranking nor the retrieved chunks")
    if ev["c-03"]["payload"]["document_blocks"] != [c["id"] for c in sel]:
        err("combined", "c-03 document blocks differ from the retrieved chunks")
    trust_of = {d["id"]: d["trust"] for d in rag["fixtures"]["documents"]}
    for eid in ("c-04", "c-06"):
        if ev[eid]["payload"]["messages"][1]["content"] != user_message(comp["question"], sel, trust_of):
            err("combined", f"{eid} user message differs from the derivation")
    query = {e["id"]: e for e in registry["rag-query"]["events"]}
    for eid in ("retrieve-05", "retrieve-06"):
        if any(ev[eid].get(f) != query[eid].get(f) for f in ("payload", "explanation", "tracked_values")):
            err("combined", f"{eid} differs from rag-query's derivation at the defaults")
    applies_expl = applies["explanation"] if applies else composition["explanation"]
    if ev["c-07"]["explanation"] != applies_expl:
        err("combined", "c-07 explanation differs from answer_composition")
    if ev["c-07"]["payload"]["message"]["content"] != a + "\n\nSources:\n" + "\n".join(R["source_lines"](cites)):
        err("combined", "c-07 model message differs")
    if ev["c-08"]["payload"]["answer"] != a or ev["c-08"]["payload"]["sources"] != R["source_objects"](cites):
        err("combined", "c-08 answer or sources differ")


def dump_rag(rag):
    """Rankings, selections and answers over a grid of parameters (golden test of the
    TypeScript RAG engine)."""
    R = rag_engine(rag)
    chunking = next(sc for sc in rag["scenarios"] if sc["id"] == "rag-index")["parameters"]
    out = []
    for name in ("rag-query",):
        docs = R["corpus"]()
        for size in chunking["chunk_size_words"]["options"]:
            for ov in chunking["overlap_words"]["options"]:
                ranking = None
                for top_k in (1, 5, 8):
                    for thr in (0, 0.7, 0.95):
                        for rerank in (False, True):
                            _, ranked, sel = R["retrieve"](docs, size=size, ov=ov, top_k=top_k, thr=thr, rerank=rerank)
                            if ranking is None:
                                ranking = [[c["id"], c["score"], c["keyword"], c["rerank"], c["embedding"]] for c in ranked]
                                out.append({"case": name, "size": size, "overlap": ov, "ranking": ranking})
                            for fetch in (False, True):
                                evidence = R["parents"](sel, docs) if fetch else sel
                                parts, cites, _ = R["answer_parts"](evidence)
                                a = " ".join(p["text"] for p in parts)
                                out.append({"case": name, "size": size, "overlap": ov, "top_k": top_k,
                                            "threshold": thr, "rerank": rerank, "fetch": fetch,
                                            "selected": [c["id"] for c in sel],
                                            "evidence": [c["id"] for c in evidence], "answer": a,
                                            "parts": [[p["kind"], p["text"]] for p in parts],
                                            "sources": R["source_lines"](cites)})
    return out


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mcp-schema", required=True, help="schema.json of the pinned MCP revision")
    ap.add_argument("--dump-registry", metavar="PATH", help="write the expanded registry as JSON (golden test)")
    ap.add_argument("--dump-rag", metavar="PATH", help="write RAG results over a parameter grid as JSON (golden test)")
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

    # Origins in the initial state (03 lineage.origins); mirrors src/scenarios/validate.ts.
    for key, origin in engine["lineage"].get("origins", {}).items():
        if key not in engine["lineage"]["tracked"]:
            err("03 lineage.origins", f"{key} is not a tracked key")
        o = origin if isinstance(origin, dict) else {}
        if not str(o.get("state") or "").strip() or not str(o.get("label") or "").strip():
            err("03 lineage.origins", f"{key} needs a state and a label")
    # One scenario per use case (03 scenario_format.one_scenario_per_use_case): no variants.
    for where, doc in (("04", mcp), ("05", rag), ("06 combined", cmp_["combined"])):
        if "variants" in doc:
            err(where, "variants are not allowed: one scenario per use case")
    registry = {}
    for scn in mcp["scenarios"] + rag["scenarios"]:
        registry[scn["id"]] = scn
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
    check_compare(cmp_, registry)
    final_mcp = registry["mcp-balance"]["events"][-1]["payload"]
    if "CHF 12,500.75" not in final_mcp:
        err("mcp-balance", "final answer lacks CHF 12,500.75")
    if not str(cmp_["compare"].get("headline", "")).strip():
        err("compare", "missing headline")
    check_rag(rag, comb, registry, load("02-ui-ux.yaml"))

    total = sum(len(s["events"]) for s in registry.values())
    if args.dump_registry:
        Path(args.dump_registry).write_text(json.dumps(registry, ensure_ascii=False, indent=1))
    if args.dump_rag:
        Path(args.dump_rag).write_text(json.dumps(dump_rag(rag), ensure_ascii=False))
    if errors:
        print("\n".join(errors))
        print(f"\n{len(errors)} problem(s) in {len(registry)} scenarios")
        return 1
    print(f"OK: {len(registry)} scenarios, {total} events, all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
