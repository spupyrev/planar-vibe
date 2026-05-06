"""LR-planarity algorithm (de Fraysseix-Rosenstiehl).

Literal port of static/js/planarity-test.js. Produces a combinatorial
planar embedding for planar graphs in O(n) or reports non-planarity.

Vertex ids on the wire are arbitrary strings; internally the algorithm
operates on integer indices 0..n-1. Edge keys are `"u|v"` strings matching
the JS implementation.
"""

from __future__ import annotations

from typing import Sequence


def _edge_key(u: int, v: int) -> str:
    return f"{u}|{v}"


def _parse_edge_key(key: str) -> tuple[int, int]:
    parts = str(key).split("|")
    return (int(parts[0]), int(parts[1]))


def _empty_interval() -> dict:
    return {"low": None, "high": None}


def _copy_interval(interval: dict) -> dict:
    return {"low": interval["low"], "high": interval["high"]}


def _conflict_pair() -> dict:
    return {"left": _empty_interval(), "right": _empty_interval()}


def _top_of_stack(stack: list):
    return stack[-1] if stack else None


def _interval_empty(interval: dict) -> bool:
    return interval["low"] is None and interval["high"] is None


def _interval_conflicting(interval: dict, edge: str, state: "LRPlanarity") -> bool:
    return not _interval_empty(interval) and state.lowpt[interval["high"]] > state.lowpt[edge]


def _conflict_pair_lowest(pair: dict, state: "LRPlanarity"):
    if _interval_empty(pair["left"]):
        return state.lowpt[pair["right"]["low"]]
    if _interval_empty(pair["right"]):
        return state.lowpt[pair["left"]["low"]]
    return min(state.lowpt[pair["left"]["low"]], state.lowpt[pair["right"]["low"]])


def _has_directed_edge(state: "LRPlanarity", u: int, v: int) -> bool:
    return _edge_key(u, v) in state.directed_edge_set


def _sort_by_signed_nesting(state: "LRPlanarity", vertex: int) -> None:
    state.ordered_adjs[vertex].sort(key=lambda w: state.nesting_depth[_edge_key(vertex, w)])


def _get_side(state: "LRPlanarity", edge):
    if edge is None:
        return 1
    if edge not in state.side:
        state.side[edge] = 1
    return state.side[edge]


def _add_half_edge_first(rotation: list[list[int]], v: int, w: int) -> None:
    if w not in rotation[v]:
        rotation[v].append(w)


def _add_half_edge(rotation: list[list[int]], v: int, w: int, opts: dict | None = None) -> None:
    if w in rotation[v]:
        return
    ref = None
    use_ccw = False
    if opts and "ccw" in opts:
        ref = opts["ccw"]
        use_ccw = True
    elif opts and "cw" in opts:
        ref = opts["cw"]
        use_ccw = False

    if len(rotation[v]) == 0 or ref is None or ref < 0:
        rotation[v].append(w)
        return
    try:
        idx = rotation[v].index(ref)
    except ValueError:
        rotation[v].append(w)
        return
    if use_ccw:
        rotation[v].insert(idx + 1, w)
    else:
        rotation[v].insert(idx, w)


def _extract_faces_from_rotation(rotation: list[list[int]]) -> list[list[int]]:
    seen: set[str] = set()
    faces: list[list[int]] = []
    n = len(rotation)
    for u in range(n):
        for v in rotation[u]:
            start_key = _edge_key(u, v)
            if start_key in seen:
                continue
            start_u = u
            start_v = v
            cur_u = start_u
            cur_v = start_v
            face: list[int] = []
            while True:
                ck = _edge_key(cur_u, cur_v)
                if ck in seen:
                    break
                seen.add(ck)
                face.append(cur_u)
                adj = rotation[cur_v]
                if not adj:
                    face = []
                    break
                try:
                    idx = adj.index(cur_u)
                except ValueError:
                    face = []
                    break
                prev_idx = (idx - 1) % len(adj)
                next_v = adj[prev_idx]
                cur_u = cur_v
                cur_v = next_v
                if cur_u == start_u and cur_v == start_v:
                    break
            if face:
                faces.append(face)
    return faces


def _choose_outer_face_from_faces(faces: list[list[int]], edge_pairs: list[tuple]) -> list[int] | None:
    def ekey(u, v):
        su, sv = str(u), str(v)
        return f"{su}::{sv}" if su < sv else f"{sv}::{su}"

    edge_set: dict[str, bool] = {}
    for e in edge_pairs or []:
        if e is None or len(e) < 2:
            continue
        edge_set[ekey(e[0], e[1])] = True

    def face_has_chord(face: list[int]) -> bool:
        if not face or len(face) < 4:
            return False
        n = len(face)
        for i in range(n):
            for j in range(i + 1, n):
                is_boundary = (j == i + 1) or (i == 0 and j == n - 1)
                if is_boundary:
                    continue
                if edge_set.get(ekey(face[i], face[j])):
                    return True
        return False

    if not faces:
        return None
    best: list[int] | None = None
    for face in faces:
        if not isinstance(face, (list, tuple)) or len(face) < 3:
            continue
        if face_has_chord(face):
            continue
        if best is None or len(face) > len(best):
            best = list(face)
    return best


class LRPlanarity:
    def __init__(self, n: int, edges: list[tuple[int, int]]) -> None:
        self.n = n
        self.m = len(edges)
        self.edges = list(edges)

        self.adjs: list[list[int]] = []
        self.directed_adjs: list[list[int]] = []
        self.directed_edge_set: set[str] = set()
        self.ordered_adjs: list[list[int]] = []

        self.roots: list[int] = []
        self.height: list[int] = []
        self.parent_edge: list[str | None] = []
        self.next_index: list[int] = []

        self.lowpt: dict[str, int] = {}
        self.lowpt2: dict[str, int] = {}
        self.nesting_depth: dict[str, int] = {}
        self.ref: dict[str, str | None] = {}
        self.side: dict[str, int] = {}
        self.stack_bottom: dict[str, dict | None] = {}
        self.lowpt_edge: dict[str, str] = {}
        self.skip_init: dict[str, bool] = {}

        self.S: list[dict] = []

        self.rotation: list[list[int]] = []
        self.faces: list[list[int]] = []

    def init_adjacency(self) -> None:
        self.adjs = [[] for _ in range(self.n)]
        self.directed_adjs = [[] for _ in range(self.n)]
        self.ordered_adjs = [[] for _ in range(self.n)]
        for (u, v) in self.edges:
            self.adjs[u].append(v)
            self.adjs[v].append(u)

    def orient_edge(self, u: int, v: int) -> None:
        self.directed_adjs[u].append(v)
        self.directed_edge_set.add(_edge_key(u, v))

    def clear_skip_init(self) -> None:
        self.skip_init = {}

    def dfs_orientation(self, root: int) -> None:
        dfs_stack = [root]
        self.next_index = [0] * self.n
        self.clear_skip_init()

        while dfs_stack:
            v = dfs_stack.pop()
            parent = self.parent_edge[v]

            i = self.next_index[v]
            while i < len(self.adjs[v]):
                w = self.adjs[v][i]
                vw = _edge_key(v, w)

                if not self.skip_init.get(vw):
                    if _has_directed_edge(self, v, w) or _has_directed_edge(self, w, v):
                        self.next_index[v] += 1
                        i = self.next_index[v]
                        continue

                    self.orient_edge(v, w)
                    self.lowpt[vw] = self.height[v]
                    self.lowpt2[vw] = self.height[v]

                    if self.height[w] == -1:
                        self.parent_edge[w] = vw
                        self.height[w] = self.height[v] + 1
                        dfs_stack.append(v)
                        dfs_stack.append(w)
                        self.skip_init[vw] = True
                        break
                    else:
                        self.lowpt[vw] = self.height[w]

                self.nesting_depth[vw] = 2 * self.lowpt[vw]
                if self.lowpt2[vw] < self.height[v]:
                    self.nesting_depth[vw] += 1

                if parent is not None:
                    if self.lowpt[vw] < self.lowpt[parent]:
                        self.lowpt2[parent] = min(self.lowpt[parent], self.lowpt2[vw])
                        self.lowpt[parent] = self.lowpt[vw]
                    elif self.lowpt[vw] > self.lowpt[parent]:
                        self.lowpt2[parent] = min(self.lowpt2[parent], self.lowpt[vw])
                    else:
                        self.lowpt2[parent] = min(self.lowpt2[parent], self.lowpt2[vw])

                self.next_index[v] += 1
                i = self.next_index[v]

    def add_constraints(self, ei: str, e: str) -> bool:
        P = _conflict_pair()

        while True:
            Q = self.S.pop()
            if not _interval_empty(Q["left"]):
                Q["left"], Q["right"] = Q["right"], Q["left"]
            if not _interval_empty(Q["left"]):
                return False
            if self.lowpt[Q["right"]["low"]] > self.lowpt[e]:
                if _interval_empty(P["right"]):
                    P["right"] = _copy_interval(Q["right"])
                else:
                    self.ref[P["right"]["low"]] = Q["right"]["high"]
                P["right"]["low"] = Q["right"]["low"]
            else:
                self.ref[Q["right"]["low"]] = self.lowpt_edge[e]
            if _top_of_stack(self.S) is self.stack_bottom[ei]:
                break

        while True:
            top = _top_of_stack(self.S)
            if not top or (not _interval_conflicting(top["left"], ei, self)
                           and not _interval_conflicting(top["right"], ei, self)):
                break
            Q = self.S.pop()
            if _interval_conflicting(Q["right"], ei, self):
                Q["left"], Q["right"] = Q["right"], Q["left"]
            if _interval_conflicting(Q["right"], ei, self):
                return False
            self.ref[P["right"]["low"]] = Q["right"]["high"]
            if Q["right"]["low"] is not None:
                P["right"]["low"] = Q["right"]["low"]
            if _interval_empty(P["left"]):
                P["left"] = _copy_interval(Q["left"])
            else:
                self.ref[P["left"]["low"]] = Q["left"]["high"]
            P["left"]["low"] = Q["left"]["low"]

        if not _interval_empty(P["left"]) or not _interval_empty(P["right"]):
            self.S.append(P)
        return True

    def remove_back_edges(self, e: str) -> None:
        endpoints = _parse_edge_key(e)
        u = endpoints[0]
        while self.S and _conflict_pair_lowest(_top_of_stack(self.S), self) == self.height[u]:
            popped = self.S.pop()
            if popped["left"]["low"] is not None:
                self.side[popped["left"]["low"]] = -1

        if self.S:
            P = self.S.pop()
            while P["left"]["high"] is not None and _parse_edge_key(P["left"]["high"])[1] == u:
                P["left"]["high"] = self.ref.get(P["left"]["high"]) or None
            if P["left"]["high"] is None and P["left"]["low"] is not None:
                self.ref[P["left"]["low"]] = P["right"]["low"]
                self.side[P["left"]["low"]] = -1
                P["left"]["low"] = None
            while P["right"]["high"] is not None and _parse_edge_key(P["right"]["high"])[1] == u:
                P["right"]["high"] = self.ref.get(P["right"]["high"]) or None
            if P["right"]["high"] is None and P["right"]["low"] is not None:
                self.ref[P["right"]["low"]] = P["left"]["low"]
                self.side[P["right"]["low"]] = -1
                P["right"]["low"] = None
            self.S.append(P)

        if self.lowpt[e] < self.height[u]:
            top = _top_of_stack(self.S)
            hl = top["left"]["high"] if top else None
            hr = top["right"]["high"] if top else None
            if hl is not None and (hr is None or self.lowpt[hl] > self.lowpt[hr]):
                self.ref[e] = hl
            else:
                self.ref[e] = hr

    def dfs_testing(self, root: int) -> bool:
        dfs_stack = [root]
        self.next_index = [0] * self.n
        self.clear_skip_init()

        while dfs_stack:
            v = dfs_stack.pop()
            e = self.parent_edge[v]
            skip_final = False

            i = self.next_index[v]
            while i < len(self.ordered_adjs[v]):
                w = self.ordered_adjs[v][i]
                ei = _edge_key(v, w)

                if not self.skip_init.get(ei):
                    self.stack_bottom[ei] = _top_of_stack(self.S)
                    if ei == self.parent_edge[w]:
                        dfs_stack.append(v)
                        dfs_stack.append(w)
                        self.skip_init[ei] = True
                        skip_final = True
                        break
                    else:
                        self.lowpt_edge[ei] = ei
                        self.S.append({"left": _empty_interval(), "right": {"low": ei, "high": ei}})

                if self.lowpt[ei] < self.height[v]:
                    if w == self.ordered_adjs[v][0]:
                        self.lowpt_edge[e] = self.lowpt_edge[ei]
                    else:
                        if not self.add_constraints(ei, e):
                            return False

                self.next_index[v] += 1
                i = self.next_index[v]

            if not skip_final and e is not None:
                self.remove_back_edges(e)
        return True

    def sign(self, start_edge: str) -> int:
        dfs_stack = [start_edge]
        old_ref: dict[str, str] = {}
        while dfs_stack:
            e = dfs_stack.pop()
            if self.ref.get(e) is not None:
                dfs_stack.append(e)
                dfs_stack.append(self.ref[e])
                old_ref[e] = self.ref[e]
                self.ref[e] = None
            else:
                self.side[e] = _get_side(self, e) * _get_side(self, old_ref.get(e))
        return self.side[start_edge]

    def dfs_embedding(self, root: int) -> None:
        dfs_stack = [root]
        ind = [0] * self.n
        left_ref = [-1] * self.n
        right_ref = [-1] * self.n
        while dfs_stack:
            v = dfs_stack.pop()
            i = ind[v]
            while i < len(self.ordered_adjs[v]):
                w = self.ordered_adjs[v][i]
                ind[v] += 1
                i = ind[v]
                ei = _edge_key(v, w)
                if ei == self.parent_edge[w]:
                    _add_half_edge_first(self.rotation, w, v)
                    left_ref[v] = w
                    right_ref[v] = w
                    dfs_stack.append(v)
                    dfs_stack.append(w)
                    break
                if _get_side(self, ei) == 1:
                    _add_half_edge(self.rotation, w, v, {"ccw": right_ref[w]})
                else:
                    _add_half_edge(self.rotation, w, v, {"cw": left_ref[w]})
                    left_ref[w] = v

    def build_embedding(self) -> None:
        for v in range(self.n):
            for w in self.ordered_adjs[v]:
                e = _edge_key(v, w)
                self.nesting_depth[e] = self.sign(e) * self.nesting_depth[e]
        for v in range(self.n):
            _sort_by_signed_nesting(self, v)

        self.rotation = [[] for _ in range(self.n)]
        for v in range(self.n):
            prev = None
            for w in self.ordered_adjs[v]:
                _add_half_edge(self.rotation, v, w, {"ccw": prev})
                prev = w

        for r in self.roots:
            self.dfs_embedding(r)

        self.faces = _extract_faces_from_rotation(self.rotation)

    def run(self) -> dict:
        if self.n > 2 and self.m > 3 * self.n - 6:
            return {"ok": False, "reason": "Euler bound violated"}

        self.init_adjacency()
        self.height = [-1] * self.n
        self.parent_edge = [None] * self.n

        for v in range(self.n):
            if self.height[v] != -1:
                continue
            self.height[v] = 0
            self.roots.append(v)
            self.dfs_orientation(v)

        for v in range(self.n):
            self.ordered_adjs[v] = list(self.directed_adjs[v])
            _sort_by_signed_nesting(self, v)

        for r in self.roots:
            if not self.dfs_testing(r):
                return {"ok": False, "reason": "LR constraints conflict"}

        self.build_embedding()
        return {"ok": True}


def normalize_edges(node_ids: Sequence[str], edge_pairs: Sequence[tuple]) -> dict:
    index_by_id: dict[str, int] = {}
    id_by_index: list[str] = []
    for raw in node_ids:
        nid = str(raw)
        if nid in index_by_id:
            continue
        index_by_id[nid] = len(id_by_index)
        id_by_index.append(nid)

    edges: list[tuple[int, int]] = []
    seen: set[str] = set()
    for pair in edge_pairs:
        u_id = str(pair[0])
        v_id = str(pair[1])
        if u_id == v_id:
            continue
        if u_id not in index_by_id:
            index_by_id[u_id] = len(id_by_index)
            id_by_index.append(u_id)
        if v_id not in index_by_id:
            index_by_id[v_id] = len(id_by_index)
            id_by_index.append(v_id)
        u = index_by_id[u_id]
        v = index_by_id[v_id]
        a = min(u, v)
        b = max(u, v)
        key = _edge_key(a, b)
        if key in seen:
            continue
        seen.add(key)
        edges.append((a, b))
    return {"idByIndex": id_by_index, "indexById": index_by_id, "edges": edges}


def _map_embedding_back(ids: list[str], rotation: list[list[int]], faces: list[list[int]]) -> dict:
    mapped_rotation: list[list[str]] = []
    for row in rotation:
        mapped_rotation.append([ids[w] for w in row])
    mapped_faces: list[list[str]] = []
    for face in faces:
        mapped_faces.append([ids[w] for w in face])
    return {"rotation": mapped_rotation, "faces": mapped_faces, "outerFace": None}


def compute_planar_embedding(node_ids: Sequence[str], edge_pairs: Sequence[tuple]) -> dict:
    normalized = normalize_edges(node_ids or [], edge_pairs or [])
    test = LRPlanarity(len(normalized["idByIndex"]), normalized["edges"])
    run = test.run()
    if not run.get("ok"):
        return {
            "ok": False,
            "reason": run.get("reason"),
            "idByIndex": list(normalized["idByIndex"]),
            "indexById": dict(normalized["indexById"]),
        }
    mapped_edges = [(normalized["idByIndex"][u], normalized["idByIndex"][v]) for (u, v) in normalized["edges"]]
    mapped = _map_embedding_back(normalized["idByIndex"], test.rotation, test.faces)
    # Outer-face selection uses the string-form edges, matching JS.
    outer = _choose_outer_face_from_faces(mapped["faces"], mapped_edges)
    return {
        "ok": True,
        "idByIndex": list(normalized["idByIndex"]),
        "indexById": dict(normalized["indexById"]),
        "edges": mapped_edges,
        "rotation": mapped["rotation"],
        "faces": mapped["faces"],
        "outerFace": outer,
    }


def analyze_planar_3_tree(graph) -> dict:
    from . import graph as gu
    emb = compute_planar_embedding(graph.node_ids, graph.edge_pairs)
    if not emb.get("ok"):
        return {"ok": False, "reason": "Graph is not planar"}
    n = len(emb["idByIndex"])
    if n < 3:
        return {"ok": False, "reason": "Need at least 3 vertices"}
    outer = emb.get("outerFace")
    if not outer or len(outer) != 3:
        return {"ok": False, "reason": "Outer face is not a triangle"}
    m = len(emb["edges"])
    if m != 3 * n - 6:
        return {"ok": False, "reason": "Edge count does not match maximal planar graph"}
    adjacency = gu.create_graph(emb["idByIndex"], emb["edges"]).adjacency_sets
    outer_set = set(outer)

    unique_outer_apex_count = 0
    for v in emb["idByIndex"]:
        if v in outer_set:
            continue
        if (outer[0] in adjacency[v]
                and outer[1] in adjacency[v]
                and outer[2] in adjacency[v]):
            unique_outer_apex_count += 1
    if unique_outer_apex_count != 1:
        return {"ok": False, "reason": "Outer face does not have a unique adjacent internal vertex"}

    def triangle_neighbors(ids: list[str]) -> bool:
        return (ids[1] in adjacency[ids[0]]
                and ids[2] in adjacency[ids[0]]
                and ids[2] in adjacency[ids[1]])

    remaining: set[str] = set(emb["idByIndex"])
    changed = True
    elimination: list[dict] = []

    while changed and len(remaining) > 3:
        changed = False
        ids = list(remaining)
        for v in ids:
            if v in outer_set:
                continue
            rem_neighbors = [u for u in adjacency[v] if u in remaining]
            if len(rem_neighbors) != 3 or not triangle_neighbors(rem_neighbors):
                continue
            elimination.append({"vertex": v, "parents": list(rem_neighbors)})
            for u in rem_neighbors:
                adjacency[u].discard(v)
            remaining.discard(v)
            changed = True
            break
    if len(remaining) != 3:
        return {"ok": False, "reason": "Could not eliminate to outer triangle"}
    final_three = list(remaining)
    if (final_three[0] not in outer_set
            or final_three[1] not in outer_set
            or final_three[2] not in outer_set):
        return {"ok": False, "reason": "Remaining triangle does not match outer face"}
    if not triangle_neighbors(final_three):
        return {"ok": False, "reason": "Final three vertices do not form a triangle"}
    return {
        "ok": True,
        "embedding": emb,
        "outerFace": list(outer),
        "elimination": elimination,
        "nodeIds": list(emb["idByIndex"]),
        "edges": [tuple(e) for e in emb["edges"]],
    }


def is_planar_3_tree(graph) -> bool:
    return analyze_planar_3_tree(graph).get("ok", False)
