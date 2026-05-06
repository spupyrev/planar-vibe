"""Layout preprocessing: planarity, outer-face selection, augmentation.

Literal port of static/js/layout-preprocessing.js. Every non-trivial layout
starts with prepareGraphData / prepareGraphAndLayoutData to produce:
  - a planar embedding (from current positions if plane, else Boyer-Myrvold)
  - a chosen outer face
  - an augmented (triangulated) graph + embedding
  - an initial barycentric position map (only in the +layout variant)
"""

from __future__ import annotations

from typing import Sequence

from . import geometry as geo
from . import graph as gu
from . import planar_graph as pg


def choose_longest_face_from_embedding(embedding: dict | None) -> list[str] | None:
    if embedding is None:
        return None
    faces = embedding.get("faces") if isinstance(embedding.get("faces"), list) else []
    best: list[str] | None = None
    for face in faces:
        if not isinstance(face, (list, tuple)) or len(face) < 3:
            continue
        mapped = [str(x) for x in face]
        if best is None or len(mapped) > len(best):
            best = mapped
    if best is not None:
        return best
    outer = embedding.get("outerFace")
    return [str(x) for x in outer] if isinstance(outer, list) and len(outer) >= 3 else None


def sanitize_embedding_snapshot(embedding: dict | None) -> dict | None:
    if embedding is None or not embedding.get("ok"):
        return embedding
    id_by_index = embedding.get("idByIndex")
    idx_by_id = embedding.get("indexById")
    edges = embedding.get("edges")
    rotation = embedding.get("rotation")
    faces = embedding.get("faces")
    outer = embedding.get("outerFace")
    return {
        "ok": True,
        "idByIndex": [str(x) for x in id_by_index] if isinstance(id_by_index, list) else [],
        "indexById": dict(idx_by_id or {}),
        "edges": [(str(e[0]), str(e[1])) for e in edges] if isinstance(edges, list) else [],
        "rotation": [[str(x) for x in row] if isinstance(row, list) else [] for row in rotation] if isinstance(rotation, list) else [],
        "faces": [[str(x) for x in f] if isinstance(f, (list, tuple)) else [] for f in faces] if isinstance(faces, list) else [],
        "outerFace": [str(x) for x in outer] if isinstance(outer, list) else None,
    }


def augment_graph(graph, embedding, outer_face, augmentation_method: str, label: str, options: dict | None) -> dict:
    augmentation_options = options or None
    if augmentation_method == "face-stellation":
        augmented = pg.triangulate_by_face_stellation(graph, embedding, outer_face, augmentation_options)
    elif augmentation_method == "outer-cycle":
        augmented = pg.triangulate_by_outer_cycle(graph, embedding, outer_face, augmentation_options)
    else:
        return {"ok": False, "message": "Unknown augmentation method: " + str(augmentation_method)}
    if not augmented or not augmented.get("ok"):
        reason = augmented.get("reason") if augmented else ""
        return {"ok": False, "message": reason or (label + " augmentation failed")}
    if not isinstance(augmented.get("outerFace"), list) or len(augmented["outerFace"]) < 3:
        return {"ok": False, "message": label + " augmentation did not return an outer face"}
    augmented["outerFace"] = [str(x) for x in augmented["outerFace"]]
    triangulated = pg.analyze_internally_triangulated(augmented["embedding"], augmented["outerFace"])
    if not triangulated or not triangulated.get("ok"):
        return {
            "ok": False,
            "message": (triangulated.get("reason") if triangulated else None)
                       or (label + " augmentation did not produce an internally triangulated embedding"),
        }
    return augmented


def prepare_graph_data(graph, config: dict) -> dict:
    if (graph is None
            or not isinstance(graph.node_ids, list)
            or not isinstance(graph.edge_pairs, list)):
        raise ValueError("prepareGraphData requires a graph")
    if len(graph.node_ids) < 3:
        return {"ok": False, "message": str(config.get("failureLabel", "Layout")) + " requires at least 3 vertices"}

    augmentation_method = config.get("augmentationMethod") or "outer-cycle"
    if augmentation_method not in ("outer-cycle", "face-stellation"):
        return {"ok": False, "message": "Unknown augmentation method: " + str(config.get("augmentationMethod"))}

    current_positions = config.get("currentPositions") or {}
    drawing_embedding = pg.extract_embedding_from_positions(graph.node_ids, graph.edge_pairs, current_positions)
    extracted_embedding = sanitize_embedding_snapshot(drawing_embedding)

    base_embedding: dict | None = extracted_embedding
    if base_embedding is None:
        # Fall back to Boyer-Myrvold; imported lazily to keep optional dependency soft.
        from . import planarity
        base_embedding = planarity.compute_planar_embedding(graph.node_ids, graph.edge_pairs)
    if not base_embedding or not base_embedding.get("ok"):
        return {"ok": False, "message": str(config.get("failureLabel", "Layout")) + " requires a planar graph"}

    if augmentation_method == "outer-cycle":
        if extracted_embedding is not None and extracted_embedding.get("ok"):
            selected_outer = [str(x) for x in extracted_embedding["outerFace"]]
        else:
            selected_outer = choose_longest_face_from_embedding(base_embedding)
    else:
        outer = base_embedding.get("outerFace")
        selected_outer = [str(x) for x in outer] if isinstance(outer, list) and len(outer) >= 3 else None

    if not selected_outer or len(selected_outer) < 3:
        return {"ok": False, "message": "Could not determine outer boundary for " + str(config.get("failureLabel", "Layout"))}

    augmented = augment_graph(
        graph,
        base_embedding,
        selected_outer,
        augmentation_method,
        str(config.get("failureLabel", "Layout")),
        config.get("augmentationOptions"),
    )
    if not augmented.get("ok"):
        return augmented

    return {
        "ok": True,
        "graph": graph,
        "baseEmbedding": base_embedding,
        "outerFace": list(selected_outer),
        "augmentedOuterFace": list(augmented["outerFace"]),
        "augmented": augmented,
    }


def create_augmentation_debug_state(graph, augmented, pos_by_id: dict) -> dict:
    # UI-only in JS; kept as a no-op stub so layouts that reference it still work.
    return {
        "addedEdgePairs": [],
        "dummyIds": [],
        "dummyLabelById": {},
        "dummyPositionsById": {},
    }


def compute_initial_positions(graph, outer_face, embedding, original_graph) -> dict:
    if not embedding or not embedding.get("ok"):
        return {"ok": False, "message": "Barycentric initialization requires a planar embedding"}
    if not pg.embedding_has_face(embedding, outer_face):
        return {"ok": False, "message": "Provided outer face is not a face of the embedding"}
    # Lazy import to avoid a cycle with tutte.
    from .layouts import tutte
    initial = tutte.compute_barycentric_positions(
        graph,
        outer_face,
        {
            "initOptions": tutte.default_outer_placement_options(),
            "weights": tutte.build_tutte_weights(original_graph or graph, graph),
        },
    )
    if not initial or not initial.get("ok") or not initial.get("positions"):
        return {"ok": False, "message": initial.get("message") if initial else "Exact barycentric solve failed"}
    return {"ok": True, "positions": initial["positions"], "iters": initial.get("iters")}


def verify_embedding_with_positions(embedding: dict | None, pos_by_id: dict, options: dict) -> dict:
    emb = embedding
    if not emb or not emb.get("ok"):
        return {"ok": False, "message": "Position verification requires a planar embedding"}
    ids = [str(x) for x in emb.get("idByIndex") or []]
    if not ids:
        return {"ok": False, "message": "Position verification requires embedding vertices"}
    if pos_by_id is None or not isinstance(pos_by_id, dict):
        return {"ok": False, "message": "Position verification requires coordinates"}
    for nid in ids:
        p = pos_by_id.get(nid)
        if p is None or not geo._is_finite(p[0]) or not geo._is_finite(p[1]):
            return {"ok": False, "message": f"Position verification found missing or non-finite coordinates for vertex {nid}"}

    outer_face_opt = options.get("outerFace")
    if isinstance(outer_face_opt, list) and len(outer_face_opt) >= 3:
        outer_face = [str(x) for x in outer_face_opt]
    else:
        emb_outer = emb.get("outerFace")
        outer_face = [str(x) for x in emb_outer] if isinstance(emb_outer, list) and len(emb_outer) >= 3 else None
    if not outer_face:
        return {"ok": False, "message": "Position verification requires an outer face"}
    if not pg.embedding_has_face(emb, outer_face):
        return {"ok": False, "message": "Position verification found an outer face that is not present in the embedding"}
    if not (geo.polygon_area_abs(outer_face, pos_by_id) > 1e-12):
        return {"ok": False, "message": "Position verification found a degenerate outer face"}

    edges = options.get("edgePairs") if isinstance(options.get("edgePairs"), list) else emb.get("edges")
    if geo.has_position_crossings(pos_by_id, edges or []):
        return {"ok": False, "message": "Position verification found crossings in the drawing"}

    faces = emb.get("faces") or []
    for face in faces:
        if not isinstance(face, (list, tuple)) or len(face) < 3:
            return {"ok": False, "message": "Position verification found an invalid face in the embedding"}
        if not (geo.polygon_area_abs(face, pos_by_id) > 1e-12):
            return {"ok": False, "message": "Position verification found a degenerate face"}
    return {"ok": True}


def prepare_graph_and_layout_data(graph, config: dict) -> dict:
    label = str(config.get("failureLabel", "Layout"))
    prepared = prepare_graph_data(graph, config)
    if not prepared or not prepared.get("ok"):
        return prepared

    augmented = prepared["augmented"]
    augmented_outer = prepared["augmentedOuterFace"]
    init = compute_initial_positions(
        augmented["graph"],
        augmented_outer,
        augmented["embedding"],
        prepared["graph"],
    )
    if not init or not init.get("ok") or not init.get("positions"):
        return {"ok": False, "message": (init.get("message") if init else "") or (label + " initialization failed")}

    verification = verify_embedding_with_positions(
        augmented["embedding"],
        init["positions"],
        {"edgePairs": augmented["graph"].edge_pairs, "outerFace": augmented_outer},
    )
    if not verification.get("ok"):
        return {"ok": False, "message": verification.get("message") or (label + " initialization failed")}

    return {
        "ok": True,
        "graph": prepared["graph"],
        "baseEmbedding": prepared["baseEmbedding"],
        "outerFace": prepared["outerFace"],
        "augmentedOuterFace": augmented_outer,
        "augmented": augmented,
        "posById": init["positions"],
        "movableVertices": gu.collect_movable_vertices(augmented["graph"].node_ids, augmented_outer),
        "initResult": init,
    }
