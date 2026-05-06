"""Planar embedding helpers and augmentation routines.

Literal port of static/js/planar-graph-utils.js. The two main entry points
used by layouts are `extract_embedding_from_positions` (reads a drawing and
returns the combinatorial embedding) and `triangulate_by_face_stellation` /
`triangulate_by_outer_cycle` (add dummy vertices so interior faces are
triangles and the outer face is fixed).

All embeddings are dicts matching the JS shape:
    { "ok": True,
      "idByIndex": [...],
      "indexById": {id: idx},
      "edges": [(u, v), ...],
      "rotation": [[neighbor_ids_ccw], ...]  # one row per vertex, by index
      "faces": [[id, id, ...], ...],
      "outerFace": [id, id, ...] | None }
"""

from __future__ import annotations

import math
from typing import Sequence

from . import geometry as geo
from . import graph as gu


def same_cyclic_direction(a: Sequence, b: Sequence) -> bool:
    if not isinstance(a, (list, tuple)) or not isinstance(b, (list, tuple)):
        return False
    if len(a) != len(b) or len(a) == 0:
        return False
    target = [str(x) for x in b]
    source = [str(x) for x in a]
    n = len(source)
    for offset in range(n):
        ok = True
        for i in range(n):
            if source[(offset + i) % n] != target[i]:
                ok = False
                break
        if ok:
            return True
    return False


def same_cyclic_either_direction(a: Sequence, b: Sequence) -> bool:
    if same_cyclic_direction(a, b):
        return True
    return same_cyclic_direction(a, list(reversed(list(b or []))))


def extract_faces_from_rotation_map(rotation: dict[str, list[str]]) -> list[list[str]]:
    seen: set[str] = set()
    faces: list[list[str]] = []

    def half_edge_key(u: str, v: str) -> str:
        return f"{u}|{v}"

    vertices = list(rotation.keys()) if rotation else []
    for u_raw in vertices:
        u = str(u_raw)
        row = rotation.get(u, [])
        for v_raw in row:
            v = str(v_raw)
            if half_edge_key(u, v) in seen:
                continue
            start_u = u
            start_v = v
            cur_u = start_u
            cur_v = start_v
            face: list[str] = []
            while True:
                ck = half_edge_key(cur_u, cur_v)
                if ck in seen:
                    break
                seen.add(ck)
                face.append(cur_u)

                adj = rotation.get(cur_v)
                if not adj or len(adj) == 0:
                    face = []
                    break
                try:
                    idx = adj.index(cur_u)
                except ValueError:
                    face = []
                    break

                prev_idx = (idx - 1) % len(adj)
                next_v = str(adj[prev_idx])
                cur_u = cur_v
                cur_v = next_v
                if cur_u == start_u and cur_v == start_v:
                    break
            if len(face) >= 3:
                faces.append(face)
    return faces


def build_rotation_from_positions(
    node_ids: Sequence[str],
    edge_pairs: Sequence[tuple[str, str]],
    pos_by_id: dict,
) -> dict[str, list[str]] | None:
    adjacency: dict[str, list[str]] = {}
    for nid in node_ids:
        adjacency[str(nid)] = []
    for (a_raw, b_raw) in edge_pairs:
        a = str(a_raw)
        b = str(b_raw)
        if a not in adjacency or b not in adjacency:
            return None
        adjacency[a].append(b)
        adjacency[b].append(a)

    rotation: dict[str, list[str]] = {}
    for nid_raw in node_ids:
        u = str(nid_raw)
        pu = pos_by_id.get(u)
        if pu is None or not _finite(pu[0]) or not _finite(pu[1]):
            return None
        neighbors = list(adjacency.get(u, []))

        def sort_key(n):
            pn = pos_by_id.get(n)
            # Tuple key: (angle, dist, id) to mimic JS comparator (stable, ties broken by dist then id).
            if pn is None:
                return (float("inf"), float("inf"), n)
            angle = math.atan2(pn[1] - pu[1], pn[0] - pu[0])
            dx = pn[0] - pu[0]
            dy = pn[1] - pu[1]
            dist = dx * dx + dy * dy
            return (angle, dist, n)

        # Match JS pairwise comparator with 1e-12 tolerances: direct sort by tuple with absolute compare is
        # nearly equivalent, but not exactly — replicate via stable sort + manual comparator.
        neighbors_sorted = _sort_with_comparator(neighbors, lambda a_, b_: _compare_neighbors(a_, b_, pu, pos_by_id))
        rotation[u] = neighbors_sorted
    return rotation


def _compare_neighbors(a: str, b: str, pu: tuple, pos_by_id: dict) -> int:
    pa = pos_by_id.get(a)
    pb = pos_by_id.get(b)
    if pa is None or pb is None:
        if a < b:
            return -1
        if a > b:
            return 1
        return 0
    angle_a = math.atan2(pa[1] - pu[1], pa[0] - pu[0])
    angle_b = math.atan2(pb[1] - pu[1], pb[0] - pu[0])
    if abs(angle_a - angle_b) > 1e-12:
        return -1 if angle_a < angle_b else 1
    dist_a = (pa[0] - pu[0]) ** 2 + (pa[1] - pu[1]) ** 2
    dist_b = (pb[0] - pu[0]) ** 2 + (pb[1] - pu[1]) ** 2
    if abs(dist_a - dist_b) > 1e-12:
        return -1 if dist_a < dist_b else 1
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def _sort_with_comparator(items, cmp):
    """Stable mergesort with a 3-way comparator (returns -1/0/1)."""
    import functools
    return sorted(items, key=functools.cmp_to_key(cmp))


def find_face_index(faces: Sequence[Sequence], face: Sequence, allow_reverse: bool = False) -> int:
    if faces is None:
        return -1
    for i, f in enumerate(faces):
        if same_cyclic_direction(f, face):
            return i
        if allow_reverse and same_cyclic_either_direction(f, face):
            return i
    return -1


def find_outer_face_index(faces: Sequence[Sequence], outer_face: Sequence) -> int:
    if not faces or not outer_face:
        return -1
    if len(outer_face) == 0:
        return -1
    return find_face_index(faces, outer_face, True)


def largest_area_face(faces: Sequence[Sequence], pos_by_id: dict) -> list[str] | None:
    best: list[str] | None = None
    best_area = -1.0
    for face in (faces or []):
        if not face or len(face) < 3:
            continue
        area = geo.polygon_area_abs(face, pos_by_id)
        if area > best_area + 1e-9:
            best_area = area
            best = [str(x) for x in face]
        elif abs(area - best_area) <= 1e-9 and best is not None and len(face) > len(best):
            best = [str(x) for x in face]
    return best


def insert_before(lst: list, before_value, value) -> None:
    sval = str(value)
    try:
        idx = lst.index(str(before_value))
    except ValueError:
        raise ValueError("Could not locate face wedge while updating rotation")
    if sval in lst:
        return
    lst.insert(idx, sval)


def has_complete_finite_positions(node_ids: Sequence, pos_by_id: dict) -> bool:
    if not isinstance(node_ids, (list, tuple)) or pos_by_id is None:
        return False
    for nid in node_ids:
        p = pos_by_id.get(str(nid))
        if p is None or not _finite(p[0]) or not _finite(p[1]):
            return False
    return True


def embedding_has_face(embedding: dict | None, face: Sequence) -> bool:
    faces = embedding.get("faces") if embedding else None
    if not isinstance(faces, list):
        return False
    for f in faces:
        if same_cyclic_either_direction(face, f):
            return True
    return False


def build_outer_face_edge_set(edge_pairs: Sequence[tuple[str, str]]) -> dict[str, bool]:
    out: dict[str, bool] = {}
    if not isinstance(edge_pairs, (list, tuple)):
        return out
    for e in edge_pairs:
        if not e or len(e) < 2:
            continue
        out[gu.edge_key(e[0], e[1])] = True
    return out


def face_chord_count(face: Sequence, edge_set: dict) -> int:
    if not isinstance(face, (list, tuple)) or len(face) < 4:
        return 0
    count = 0
    n = len(face)
    for i in range(n):
        for j in range(i + 1, n):
            is_boundary = (j == i + 1) or (i == 0 and j == n - 1)
            if is_boundary:
                continue
            if edge_set.get(gu.edge_key(face[i], face[j])):
                count += 1
    return count


def choose_outer_face_from_embedding(embedding: dict | None) -> list[str] | None:
    if embedding is None:
        return None
    outer = embedding.get("outerFace")
    explicit = [str(x) for x in outer] if isinstance(outer, list) and len(outer) >= 3 else None
    edges = embedding.get("edges")
    edge_set = build_outer_face_edge_set(edges) if isinstance(edges, list) else {}
    if explicit is not None and (not isinstance(edges, list) or face_chord_count(explicit, edge_set) == 0):
        return explicit
    faces = embedding.get("faces")
    if isinstance(faces, list) and faces:
        best: list[str] | None = None
        for face in faces:
            if not isinstance(face, (list, tuple)) or len(face) < 3:
                continue
            mapped = [str(x) for x in face]
            if face_chord_count(mapped, edge_set) != 0:
                continue
            if best is None or len(mapped) > len(best):
                best = mapped
        return best
    return None


def extract_embedding_from_positions(
    node_ids: Sequence[str],
    edge_pairs: Sequence[tuple[str, str]],
    pos_by_id: dict,
) -> dict | None:
    if not isinstance(node_ids, (list, tuple)) or not isinstance(edge_pairs, (list, tuple)) or pos_by_id is None:
        return None
    if not has_complete_finite_positions(node_ids, pos_by_id):
        return None
    if geo.has_position_crossings(pos_by_id, edge_pairs):
        return None
    pe = PlanarEmbedding.from_drawing({"nodeIds": list(node_ids), "edgePairs": list(edge_pairs)}, pos_by_id)
    return pe.to_embedding_object() if pe is not None else None


def choose_outer_face_from_positions(
    node_ids: Sequence[str],
    edge_pairs: Sequence[tuple[str, str]],
    pos_by_id: dict,
) -> list[str] | None:
    emb = extract_embedding_from_positions(node_ids, edge_pairs, pos_by_id)
    if emb and emb.get("ok") and emb.get("outerFace"):
        return [str(x) for x in emb["outerFace"]]
    return None


def split_face_into_segments(face: Sequence) -> list[list[str]]:
    if not face:
        return []
    original = [str(x) for x in face]
    walk = list(original)
    if walk[-1] != walk[0]:
        walk.append(walk[0])

    segments: list[list[str]] = []
    current: list[str] = []
    seen: set[str] = set()
    counts: dict[str, int] = {}
    for c in original:
        counts[c] = counts.get(c, 0) + 1

    for v in walk:
        if v not in seen:
            current.append(v)
            seen.add(v)
            continue
        if current:
            segments.append(list(current))
        current = [v]
        seen = {v}

    if (len(current) > 1
            or (len(current) == 1 and current[0] != walk[0])
            or (len(current) == 1 and current[0] == walk[0] and counts.get(current[0], 0) > 1)):
        segments.append(list(current))
    return segments


def analyze_internally_triangulated(embedding: dict | None, outer_face: Sequence | None) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "reason": "Embedding is not internally triangulated: valid embedding required"}
    faces = embedding.get("faces")
    if not isinstance(faces, list):
        return {"ok": False, "reason": "Embedding is not internally triangulated: faces are missing"}
    if isinstance(outer_face, list) and len(outer_face) >= 3:
        selected = [str(x) for x in outer_face]
    else:
        emb_outer = embedding.get("outerFace")
        selected = [str(x) for x in emb_outer] if isinstance(emb_outer, list) and len(emb_outer) >= 3 else None
    if selected is None:
        return {"ok": False, "reason": "Embedding is not internally triangulated: outer face is missing"}
    outer_index = find_face_index(faces, selected, True)
    if outer_index < 0:
        return {"ok": False, "reason": "Embedding is not internally triangulated: outer face not found in embedding"}
    for i, face in enumerate(faces):
        if i == outer_index:
            continue
        if not isinstance(face, (list, tuple)) or len(face) != 3:
            return {
                "ok": False,
                "reason": f"Embedding is not internally triangulated: non-outer face has length {len(face) if face else 0}",
                "witness": {
                    "type": "non-triangular-face",
                    "face": [str(x) for x in face] if isinstance(face, (list, tuple)) else None,
                    "faceIndex": i,
                },
            }
    return {"ok": True}


def triangulate_by_face_stellation(graph, embedding, outer_face, options: dict | None = None) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "reason": "triangulateByFaceStellation requires a planar embedding"}
    selected = [str(x) for x in outer_face] if isinstance(outer_face, (list, tuple)) else None
    if not selected or len(selected) < 3:
        return {"ok": False, "reason": "triangulateByFaceStellation requires an outer face"}
    opts = options or {}
    pe = PlanarEmbedding.from_embedding_object(graph, embedding, selected)
    interior = _triangulate_interior_faces(pe, selected)
    if not interior["ok"]:
        return interior
    outer = _triangulate_outer_face_if_requested(pe, selected, opts)
    if not outer["ok"]:
        return outer
    final_embedding = pe.to_embedding_object()
    final_graph = pe.to_graph()
    outer_dummy_ids = [str(x) for x in outer.get("outerDummyIds", [])]
    final_graph._outer_dummy_ids = list(outer_dummy_ids)  # attach as attribute for parity with JS
    return {
        "ok": True,
        "graph": final_graph,
        "dummyCount": interior["dummyCount"] + outer["dummyCount"],
        "embedding": final_embedding,
        "outerFace": list(final_embedding["outerFace"]) if final_embedding.get("outerFace") else None,
        "outerDummyIds": outer_dummy_ids,
    }


def triangulate_by_outer_cycle(graph, embedding, outer_face, options: dict | None = None) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "reason": "triangulateByOuterCycle requires a planar embedding"}
    selected = [str(x) for x in outer_face] if isinstance(outer_face, (list, tuple)) else None
    if not selected or len(selected) < 3:
        return {"ok": False, "reason": "triangulateByOuterCycle requires an outer face"}
    pe = PlanarEmbedding.from_embedding_object(graph, embedding, selected)
    opts = options or {}
    dummy_count = 0
    try:
        outer_dummy_ids = pe.add_outer_face_cycle(selected, opts)
    except ValueError as err:
        return {"ok": False, "reason": str(err) or "Outer-cycle augmentation failed"}
    dummy_count += len(outer_dummy_ids)
    selected = list(pe.outer_face) if pe.outer_face else selected
    interior = _triangulate_interior_faces(pe, selected)
    if not interior["ok"]:
        return interior
    dummy_count += interior["dummyCount"]
    outer = _triangulate_outer_face_if_requested(pe, selected, opts)
    if not outer["ok"]:
        return outer
    dummy_count += outer["dummyCount"]
    final_embedding = pe.to_embedding_object()
    final_graph = pe.to_graph()
    tri = analyze_internally_triangulated(
        final_embedding,
        final_embedding.get("outerFace") if isinstance(final_embedding.get("outerFace"), list) else selected,
    )
    if not tri.get("ok"):
        reason = tri.get("reason", "")
        return {
            "ok": False,
            "reason": ("Outer-cycle augmentation did not produce an internally triangulated embedding: " + reason
                       if reason else "Outer-cycle augmentation did not produce an internally triangulated embedding"),
        }
    combined_outer = list(outer_dummy_ids) + [str(x) for x in outer.get("outerDummyIds", [])]
    final_graph._outer_dummy_ids = list(combined_outer)
    return {
        "ok": True,
        "graph": final_graph,
        "dummyCount": dummy_count,
        "embedding": final_embedding,
        "outerFace": list(final_embedding["outerFace"]) if final_embedding.get("outerFace") else None,
        "outerDummyIds": combined_outer,
    }


def _triangulate_face(pe: "PlanarEmbedding", face: Sequence, options: dict | None = None) -> int:
    opts = options or {}
    matched = pe.get_face(face)
    if matched is None:
        raise ValueError("Face not found in embedding")
    if len(matched) < 3:
        raise ValueError("Cannot stellate a face with fewer than 3 vertices")

    def create_dummy(prefix: str) -> str:
        dummy = pe._next_dummy_id(prefix)
        pe.index_by_id[dummy] = len(pe.node_ids)
        pe.node_ids.append(dummy)
        pe.rotation_by_id[dummy] = []
        created = opts.get("createdDummyIds")
        if isinstance(created, list):
            created.append(dummy)
        return dummy

    def link_dummy_to_dummy(prev_dummy: str, next_dummy: str) -> None:
        if not pe._add_edge(prev_dummy, next_dummy):
            raise ValueError("Dummy path introduced a duplicate edge")
        pe.rotation_by_id[prev_dummy].append(next_dummy)
        pe.rotation_by_id[next_dummy].append(prev_dummy)

    def link_dummy_to_boundary(dummy: str, vertex: str, previous_boundary: str) -> None:
        if not pe._add_edge(dummy, vertex):
            raise ValueError("Face triangulation still produced a multi-edge")
        insert_before(pe.rotation_by_id[vertex], previous_boundary, dummy)
        pe.rotation_by_id[dummy].append(vertex)

    prefix = opts.get("dummyPrefix") or "@dummy"
    segments = split_face_into_segments(matched)
    first_vertex = str(matched[0])
    previous_boundary = str(matched[-1])
    dummy_ids: list[str] = []
    dummy_count = 0

    for i, seg in enumerate(segments):
        dummy_id = create_dummy(prefix)
        dummy_ids.append(dummy_id)
        dummy_count += 1
        if i > 0:
            prev_dummy_id = dummy_ids[i - 1]
            prev_segment = segments[i - 1]
            prev_segment_last = str(prev_segment[-1])
            link_dummy_to_dummy(prev_dummy_id, dummy_id)
            link_dummy_to_boundary(dummy_id, prev_segment_last, prev_dummy_id)
        previous_boundary = (str(segments[i - 1][-1]) if i > 0 else str(matched[-1]))
        for v_raw in seg:
            vertex = str(v_raw)
            link_dummy_to_boundary(dummy_id, vertex, previous_boundary)
            previous_boundary = vertex

    if len(dummy_ids) > 2:
        center_dummy_id = create_dummy(prefix)
        dummy_count += 1
        if not pe._add_edge(center_dummy_id, first_vertex):
            raise ValueError("Face triangulation still produced a multi-edge")
        insert_before(pe.rotation_by_id[first_vertex], dummy_ids[-1], center_dummy_id)
        pe.rotation_by_id[center_dummy_id].append(first_vertex)
        for d_id in dummy_ids:
            if not pe._add_edge(center_dummy_id, d_id):
                raise ValueError("Face triangulation still produced a multi-edge")
            pe.rotation_by_id[d_id].append(center_dummy_id)
            pe.rotation_by_id[center_dummy_id].append(d_id)

    pe.recompute_faces()
    if opts.get("newOuterFace"):
        pe.set_outer_face([dummy_ids[0], matched[0], matched[1]])
    return dummy_count


def _triangulate_interior_faces(pe: "PlanarEmbedding", outer_face: Sequence) -> dict:
    dummy_count = 0
    faces = list(pe.faces)
    for face in faces:
        if not face or len(face) <= 3:
            continue
        if same_cyclic_either_direction(face, outer_face):
            continue
        try:
            dummy_count += _triangulate_face(pe, [str(x) for x in face])
        except ValueError as err:
            return {"ok": False, "reason": str(err) or "Interior face augmentation failed"}
    return {"ok": True, "dummyCount": dummy_count}


def _triangulate_outer_face_if_requested(pe: "PlanarEmbedding", outer_face: Sequence, options: dict) -> dict:
    if not options.get("triangulateOuterFace") or not outer_face or len(outer_face) <= 3:
        return {"ok": True, "dummyCount": 0, "outerDummyIds": []}
    try:
        outer_dummy_ids: list[str] = []
        dummy_count = _triangulate_face(pe, outer_face, {
            "dummyPrefix": "@outerDummy",
            "newOuterFace": True,
            "createdDummyIds": outer_dummy_ids,
        })
        return {"ok": True, "dummyCount": dummy_count, "outerDummyIds": outer_dummy_ids}
    except ValueError as err:
        return {"ok": False, "reason": str(err) or "Outer-face augmentation failed"}


class PlanarEmbedding:
    def __init__(self, options: dict) -> None:
        opts = options or {}
        if not isinstance(opts.get("nodeIds"), list):
            raise ValueError("PlanarEmbedding requires nodeIds array")
        if not isinstance(opts.get("edgePairs"), list):
            raise ValueError("PlanarEmbedding requires edgePairs array")

        self.node_ids: list[str] = list(opts["nodeIds"])
        self.edge_pairs: list[tuple[str, str]] = gu.clone_edge_pairs(opts["edgePairs"])
        self.index_by_id: dict[str, int] = {}
        self.rotation_by_id: dict[str, list[str]] = {}
        self.faces: list[list[str]] = []
        outer = opts.get("outerFace")
        self.outer_face: list[str] | None = list(outer) if isinstance(outer, list) else None

        for i, nid in enumerate(self.node_ids):
            if not isinstance(nid, str):
                raise TypeError("PlanarEmbedding node ids must be strings")
            self.index_by_id[nid] = i

        source_rotation = opts.get("rotationById") or {}
        for nid in self.node_ids:
            row = source_rotation.get(nid)
            self.rotation_by_id[nid] = list(row) if isinstance(row, list) else []

        self._edge_set: set[str] = set()
        for (u, v) in self.edge_pairs:
            self._edge_set.add(gu.edge_key(u, v))

        faces = opts.get("faces")
        if isinstance(faces, list) and len(faces) > 0:
            self.faces = [list(face) for face in faces]
        else:
            self.recompute_faces()

    @classmethod
    def from_embedding_object(cls, graph, embedding: dict | None, outer_face: Sequence | None) -> "PlanarEmbedding":
        ids = list(graph.node_ids)
        pairs = gu.clone_edge_pairs(graph.edge_pairs)
        rotation_by_id: dict[str, list[str]] = {}
        for i, nid in enumerate(ids):
            idx = embedding["indexById"].get(nid, i) if embedding and embedding.get("indexById") else i
            rotation = embedding.get("rotation") if embedding else None
            row = rotation[idx] if isinstance(rotation, list) and 0 <= idx < len(rotation) else []
            rotation_by_id[nid] = list(row) if isinstance(row, list) else []
        outer = (list(outer_face)
                 if outer_face is not None
                 else (embedding.get("outerFace") if embedding else None))
        return cls({
            "nodeIds": ids,
            "edgePairs": pairs,
            "rotationById": rotation_by_id,
            "faces": embedding.get("faces") if embedding else None,
            "outerFace": outer,
        })

    @classmethod
    def from_drawing(cls, graph: dict, pos_by_id: dict) -> "PlanarEmbedding | None":
        ids = list(graph.get("nodeIds") or [])
        pairs = gu.clone_edge_pairs(graph.get("edgePairs") or [])
        rotation_by_id = build_rotation_from_positions(ids, pairs, pos_by_id or {})
        if rotation_by_id is None:
            return None
        faces = extract_faces_from_rotation_map(rotation_by_id)
        if not faces:
            return None
        return cls({
            "nodeIds": ids,
            "edgePairs": pairs,
            "rotationById": rotation_by_id,
            "faces": faces,
            "outerFace": largest_area_face(faces, pos_by_id or {}),
        })

    def clone(self) -> "PlanarEmbedding":
        return PlanarEmbedding({
            "nodeIds": self.node_ids,
            "edgePairs": self.edge_pairs,
            "rotationById": self.rotation_by_id,
            "faces": self.faces,
            "outerFace": self.outer_face,
        })

    def recompute_faces(self) -> list[list[str]]:
        self.faces = [[str(x) for x in f] for f in extract_faces_from_rotation_map(self.rotation_by_id)]
        return self.faces

    def has_face(self, face: Sequence) -> bool:
        return find_face_index(self.faces, face) >= 0

    def get_face(self, face: Sequence) -> list[str] | None:
        idx = find_face_index(self.faces, face)
        if idx < 0:
            return None
        return [str(x) for x in self.faces[idx]]

    def _next_dummy_id(self, prefix: str | None) -> str:
        base = str(prefix or "@dummy")
        nid = base
        suffix = 0
        while nid in self.index_by_id:
            suffix += 1
            nid = base + str(suffix)
        return nid

    def _add_edge(self, u, v) -> bool:
        key = gu.edge_key(u, v)
        if key in self._edge_set:
            return False
        self._edge_set.add(key)
        self.edge_pairs.append((str(u), str(v)))
        return True

    def set_outer_face(self, face: Sequence) -> list[str]:
        matched = self.get_face(face)
        if matched is None:
            raise ValueError("Requested outer face is not present in the embedding")
        self.outer_face = matched
        return [str(x) for x in self.outer_face]

    def add_face_dummy(self, face: Sequence, dummy_id: str | None = None, options: dict | None = None) -> str:
        opts = options or {}
        matched = self.get_face(face)
        if matched is None:
            raise ValueError("Face not found in embedding")
        if len(matched) < 3:
            raise ValueError("Cannot stellate a face with fewer than 3 vertices")
        seen: set[str] = set()
        for b in matched:
            bid = str(b)
            if bid in seen:
                raise ValueError("Face stellation requires a simple boundary")
            seen.add(bid)

        is_outer = self.outer_face is not None and same_cyclic_direction(self.outer_face, matched)
        if is_outer and not opts.get("newOuterFace"):
            raise ValueError("Splitting the outer face requires a replacement outer face")

        dummy = str(dummy_id or self._next_dummy_id("@dummy"))
        if dummy in self.index_by_id:
            raise ValueError("Dummy vertex already exists: " + dummy)

        self.index_by_id[dummy] = len(self.node_ids)
        self.node_ids.append(dummy)
        self.rotation_by_id[dummy] = [str(x) for x in matched]

        n = len(matched)
        for i in range(n):
            v = str(matched[i])
            prev = str(matched[(i - 1) % n])
            self._add_edge(dummy, v)
            insert_before(self.rotation_by_id[v], prev, dummy)

        self.recompute_faces()
        if opts.get("newOuterFace"):
            self.set_outer_face(opts["newOuterFace"])
        elif is_outer:
            raise ValueError("Outer face split did not define a replacement outer face")
        elif self.outer_face and not self.has_face(self.outer_face):
            raise ValueError("Existing outer face was not preserved")
        return dummy

    def add_outer_face_cycle(self, face: Sequence, options: dict | None = None) -> list[str]:
        matched = self.get_face(face)
        if matched is None:
            raise ValueError("Outer face not found in embedding")
        if len(matched) < 3:
            raise ValueError("Outer-cycle augmentation requires at least 3 boundary vertices")
        if self.outer_face is None or not same_cyclic_direction(self.outer_face, matched):
            raise ValueError("Outer-cycle augmentation requires the chosen outer face")

        opts = options or {}
        dummy_ids: list[str] = []
        for _ in matched:
            dummy = self._next_dummy_id(opts.get("outerDummyPrefix") or "@outerDummy")
            self.index_by_id[dummy] = len(self.node_ids)
            self.node_ids.append(dummy)
            self.rotation_by_id[dummy] = []
            dummy_ids.append(dummy)

        n = len(matched)
        for i in range(n):
            v = str(matched[i])
            nxt = str(matched[(i + 1) % n])
            prev = str(matched[(i - 1) % n])
            dc = str(dummy_ids[i])
            dp = str(dummy_ids[(i - 1) % n])
            dn = str(dummy_ids[(i + 1) % n])

            self._add_edge(dc, v)
            self._add_edge(dc, nxt)
            self._add_edge(dc, dn)

            insert_before(self.rotation_by_id[v], prev, dc)
            insert_before(self.rotation_by_id[v], prev, dp)

            self.rotation_by_id[dc] = [dp, v, nxt, dn]

        self.recompute_faces()
        self.set_outer_face(dummy_ids)
        return list(dummy_ids)

    def to_embedding_object(self) -> dict:
        rotation: list[list[str]] = []
        for nid in self.node_ids:
            row = self.rotation_by_id.get(nid, [])
            rotation.append([str(x) for x in row])
        return {
            "ok": True,
            "idByIndex": [str(x) for x in self.node_ids],
            "indexById": dict(self.index_by_id),
            "edges": gu.clone_edge_pairs(self.edge_pairs),
            "rotation": rotation,
            "faces": [[str(x) for x in face] for face in self.faces],
            "outerFace": [str(x) for x in self.outer_face] if self.outer_face else None,
        }

    def to_graph(self):
        return gu.create_graph(self.node_ids, self.edge_pairs)


def _finite(x) -> bool:
    if x is None or isinstance(x, bool):
        return False
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False
