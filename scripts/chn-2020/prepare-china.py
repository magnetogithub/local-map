"""Offline CHN adapter. Raw administrative geometry and gameplay residuals stay distinct.

Requires the pinned Python environment in requirements.txt. Never changes current.json.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from collections import defaultdict
from fractions import Fraction

import shapely
from shapely import affinity
from shapely.geometry import shape, mapping, Polygon, MultiPoint, LineString
from shapely.ops import orient
from pyproj import Geod

ROOT = Path(__file__).resolve().parents[2]
GEOD = Geod(ellps="WGS84")
SOURCE_ID = "geoboundaries-CHN-ADM3-62558664-9469f095"
RAW = "data/raw/chn-2020/references/geoBoundaries-CHN-ADM3.geojson"
BASELINE = "reports/maintenance/prompt19-C/western-sector-2020-joined-world-input.json"


def read(file):
    return json.loads((ROOT / file).read_text("utf-8"))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode()


def pin(file):
    data = (ROOT / file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


def immutable(file, value):
    target = ROOT / file
    target.parent.mkdir(parents=True, exist_ok=True)
    data = encoded(value)
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("IMMUTABLE_OUTPUT_CHANGED:" + file)
    else:
        target.write_bytes(data)
    return pin(file)


def parts(g):
    if g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if hasattr(g, "geoms"):
        return [p for c in g.geoms for p in parts(c)]
    return []


def lines(g):
    if g.is_empty:
        return []
    if g.geom_type in ("LineString", "LinearRing"):
        return [g]
    return [p for c in getattr(g, "geoms", []) for p in lines(c)]


def area_km(g):
    return sum(abs(GEOD.geometry_area_perimeter(orient(p, 1))[0]) / 1e6 for p in parts(g))


def geometry(g):
    ps = [orient(p, 1) for p in parts(g)]
    if not ps:
        raise ValueError("EMPTY_POLYGON")
    return mapping(ps[0] if len(ps) == 1 else shapely.MultiPolygon(ps))


def key(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def residual_partition(residual, original, tree, explicit_contacts=None, stage="pre-common-mesh", source_boundary_cache=None):
    """Contact-seeded gameplay partition ONLY inside actual source-free P0 land.

    Contact line samples approximate distance; no administrative truth is inferred.
    Every delivered connected gain must retain positive contact with its raw family.
    """
    assigned = defaultdict(list)
    ledger = []
    fallback = []
    for n, r in enumerate(parts(residual)):
        if n % 100 == 0:
            print("residual", n, "of", len(parts(residual)), flush=True)
        witnesses = []
        if explicit_contacts is not None:
            if len(parts(residual)) != 1:
                raise ValueError("EXPLICIT_CONTACTS_REQUIRE_ONE_RESIDUAL_COMPONENT")
            contacts, witnesses = explicit_contacts
        else:
            contacts = []
            for i in sorted(tree.query(r)):
                contact = r.boundary.intersection(original[int(i)].boundary)
                if contact.length > 0:
                    contacts.append((int(i), contact))
        record = {"residualId": "CHN:residual:" + key(geometry(r)), "geometry": geometry(r),
                  "areaKm2": area_km(r), "contacts": [i for i, _ in contacts], "gains": [],
                  "stage": stage, "geometryAdjusted": True, "rawSourceArtifactGeometryUnmodified": True,
                  "administrativeTruthClaim": False}
        if explicit_contacts is not None:
            record["contactWitnesses"] = witnesses
        if not contacts:
            fallback.append((r, "source-free detached baseline island/component; no positive same-country fine contact"))
            record["disposition"] = "retained-source-free"
            ledger.append(record)
            continue
        if len(contacts) == 1:
            i, contact = contacts[0]
            # Unique contact is topological evidence, not a nearest-centroid allocation.
            assigned[i].append(r)
            record["method"] = "unique-positive-length-same-country-source-contact"
            gain = {"sourceIndex": i, "assignedPartGeometry": geometry(r), "areaKm2": area_km(r)}
            if explicit_contacts is not None:
                gain["contactWitnesses"] = [w for w in witnesses if w["sourceIndex"] == i]
            record["gains"].append(gain)
            record["disposition"] = "gameplay-assigned"
            ledger.append(record)
            continue
        latitude = r.representative_point().y
        xs, ys = 111.195 * math.cos(math.radians(latitude)), 111.195
        project = lambda g: affinity.scale(g, xfact=xs, yfact=ys, origin=(0, 0))
        unproject = lambda g: affinity.scale(g, xfact=1 / xs, yfact=1 / ys, origin=(0, 0))
        # 1 km contact sampling => <=0.5 km nearest-contact distance sampling error.
        # This is NOT a claimed Voronoi dividing-line positional accuracy.
        samples = {}
        for i, contact in contacts:
            # GEOS intersection often returns one line for every raw segment.
            # Chain them before distance sampling; raw-vertex sampling would
            # unnecessarily make hundreds of thousands of Voronoi sites.
            for line in lines(project(shapely.line_merge(contact))):
                count = max(1, math.ceil(line.length / 1.0))
                for s in range(count + 1):
                    pt = line.interpolate(s / count, normalized=True)
                    xy = (pt.x, pt.y)
                    # At a shared terminal, ties choose the stable raw feature index.
                    samples[xy] = min(i, samples.get(xy, i))
        sites = sorted(samples)
        if len(sites) > 1000:
            print("contact sites", n, len(sites), "areaKm2", record["areaKm2"], flush=True)
        region = project(r)
        diagrams = shapely.voronoi_polygons(MultiPoint(sites), extend_to=region.envelope, ordered=True)
        received = defaultdict(list)
        for xy, poly in zip(sites, diagrams.geoms):
            coords = shapely.get_coordinates(poly)
            if any(math.hypot(x - xy[0], y - xy[1]) > 10 for x, y in coords):
                poly = poly.intersection(shapely.Point(xy).buffer(10.0, quad_segs=8))
            piece = r.intersection(unproject(poly))
            if not piece.is_empty:
                received[samples[xy]].extend(parts(piece))
        accepted = []
        explicit_indexes = {i: segment_cover_index((tuple(a), tuple(b)) for line in lines(contact)
                             for a, b in zip(list(line.coords), list(line.coords)[1:])) for i, contact in contacts} if explicit_contacts is not None else {}
        for i, values in sorted(received.items()):
            for p in parts(shapely.union_all(values)):
                contact_witnesses = []
                if explicit_contacts is not None:
                    if source_boundary_cache is None:
                        source_boundary_cache = {}
                    if i not in source_boundary_cache:
                        source_boundary_cache[i] = segment_cover_index(each_segment(original[i]))
                    contact_witnesses = piece_contact_witnesses(p, i, explicit_indexes[i], source_boundary_cache[i])
                if contact_witnesses or explicit_contacts is None and p.boundary.intersection(original[i].boundary).length > 0:
                    assigned[i].append(p)
                    accepted.append(p)
                    gain = {"sourceIndex": i, "assignedPartGeometry": geometry(p), "areaKm2": area_km(p)}
                    if explicit_contacts is not None:
                        gain["contactWitnesses"] = contact_witnesses
                    record["gains"].append(gain)
        remaining = r.difference(shapely.union_all(accepted))
        fallback.extend((p, "source-free multi-contact land beyond 10 km contact bound or disconnected contact partition") for p in parts(remaining))
        record.update({"method": "bounded-same-country-contact-sampling-voronoi-in-existing-residual-only",
                       "distanceProjection": {"method": "local affine longitude*cos(latitude), latitude", "latitude": latitude,
                                              "xKmPerDegree": xs, "yKmPerDegree": ys},
                       "contactSamplingMaximumKm": 1, "nearestContactDistanceSamplingErrorKm": 0.5,
                       "maximumContactDistanceKm": 10, "samples": len(sites),
                       "tiePolicy": "stable pinned raw feature index at exact shared contact terminal",
                       "disposition": "gameplay-assigned-with-explicit-source-free-remainder" if not remaining.is_empty else "gameplay-assigned"})
        ledger.append(record)
    return assigned, fallback, ledger


def each_segment(g):
    for p in parts(g):
        for ring in [p.exterior, *p.interiors]:
            c = list(ring.coords)
            for a, b in zip(c, c[1:]):
                if a != b:
                    yield tuple(a), tuple(b)


def segment_key(a, b):
    return (a, b) if a < b else (b, a)


def segment_cover_index(segments):
    values = [LineString([a, b]) for a, b in segments]
    return values, shapely.STRtree(values)


def original_segment_witness(a, b, indexed):
    values, tree = indexed
    box = shapely.box(min(a[0], b[0]) - 1e-12, min(a[1], b[1]) - 1e-12,
                      max(a[0], b[0]) + 1e-12, max(a[1], b[1]) + 1e-12)
    for n in sorted(tree.query(box)):
        line = values[int(n)]
        distance = max(shapely.Point(a).distance(line), shapely.Point(b).distance(line))
        if distance <= 1e-12:
            return {"originalSegmentIndex": int(n), "originalSourceSegment": list(line.coords),
                    "maximumEndpointDistanceDegrees": distance}
    return None


def covered_by_original_segment(a, b, indexed):
    return original_segment_witness(a, b, indexed) is not None


def piece_contact_witnesses(piece, source_index, contact_index, original_index):
    """Positive portions of the piece boundary traced through a real mesh contact.

    Project only to determine the overlap interval on an existing piece edge.
    Both overlap endpoints must independently trace to the original finite source
    segment at the unchanged 1e-12 representation bound.
    """
    values, tree = contact_index
    witnesses = []
    seen = set()
    for a, b in each_segment(piece):
        edge = LineString([a, b])
        if edge.length == 0:
            continue
        box = shapely.box(min(a[0], b[0]) - 1e-12, min(a[1], b[1]) - 1e-12,
                          max(a[0], b[0]) + 1e-12, max(a[1], b[1]) + 1e-12)
        for n in sorted(tree.query(box)):
            contact = values[int(n)]
            c, d = list(contact.coords)
            if max(shapely.Point(c).distance(edge), shapely.Point(d).distance(edge)) > 1e-12:
                # A shorter piece edge may lie inside this original mesh edge.
                if max(shapely.Point(a).distance(contact), shapely.Point(b).distance(contact)) > 1e-12:
                    continue
            t0, t1 = sorted([edge.project(shapely.Point(c)), edge.project(shapely.Point(d))])
            if t1 <= t0:
                continue
            p, q = tuple(edge.interpolate(t0).coords[0]), tuple(edge.interpolate(t1).coords[0])
            if p == q or max(shapely.Point(p).distance(contact), shapely.Point(q).distance(contact)) > 1e-12:
                continue
            witness = original_segment_witness(p, q, original_index)
            identity = segment_key(p, q)
            if witness is not None and identity not in seen:
                witnesses.append({"sourceIndex": source_index, "meshSegment": [p, q], **witness})
                seen.add(identity)
    return witnesses


def boundary_point_certificate(reference, actual):
    original_points = {tuple(p) for p in shapely.get_coordinates(reference.boundary)}
    points = sorted({tuple(p) for p in shapely.get_coordinates(actual.boundary)} - original_points)
    indexed = segment_cover_index(each_segment(reference))
    result = []
    for point in points:
        witness = original_segment_witness(point, point, indexed)
        if witness is None:
            raise ValueError("BOUNDARY_POINT_WITHOUT_ORIGINAL_SEGMENT")
        result.append({"coordinate": point, "originalSegment": witness["originalSourceSegment"],
                       "originalSegmentIndex": witness["originalSegmentIndex"],
                       "measuredDistanceDegrees": witness["maximumEndpointDistanceDegrees"],
                       "maximumDistanceDegrees": 1e-12})
    return result


def union_mesh_faces(faces, directed_edges=None):
    """Exact directed segment cancellation, retaining all shared subdivision nodes.

    GEOS union may recompute a collinear intersection or remove a node. These
    already labeled faces need no overlay; walk their remaining directed edges.
    This mirrors the existing repository ringsFromSegments contract.
    """
    boundary = {}
    sequences = [directed_edges] if directed_edges is not None else [each_segment(orient(face, 1)) for face in faces]
    for sequence in sequences:
        for a, b in sequence:
            a, b = tuple(a), tuple(b)
            k = segment_key(a, b)
            if k in boundary:
                if boundary[k] != (b, a):
                    raise ValueError("NON_PARTITION_FACE_DIRECTION")
                del boundary[k]
            else:
                boundary[k] = (a, b)
    edges = sorted(boundary.values())
    outgoing = defaultdict(list)
    for i, (a, b) in enumerate(edges):
        outgoing[a].append(i)
    seen, rings = set(), []
    for start in range(len(edges)):
        if start in seen:
            continue
        current, path = start, []
        while True:
            if current in seen:
                if current != start:
                    raise ValueError("BOUNDARY_JOINS_ANOTHER_CYCLE")
                break
            seen.add(current)
            a, b = edges[current]
            path.append(a)
            reverse = math.atan2(a[1] - b[1], a[0] - b[0])
            options = outgoing[b]
            if not options:
                raise ValueError("OPEN_MESH_BOUNDARY")
            current = min(options, key=lambda i: ((reverse - math.atan2(edges[i][1][1] - b[1], edges[i][1][0] - b[0])) % (2 * math.pi), i))
        path.append(path[0])
        # Split exact point-touch cycles, preserving all positive components.
        stack, positions = [], {}
        for p in path:
            if p in positions:
                k = positions[p]
                ring = stack[k:] + [p]
                if len(ring) < 4:
                    raise ValueError("COLLAPSED_FACE_CYCLE")
                rings.append(ring)
                for q in stack[k + 1:]:
                    positions.pop(q, None)
                stack = stack[:k + 1]
            else:
                positions[p] = len(stack)
                stack.append(p)
    shells, holes = [], []
    for ring in rings:
        (shells if shapely.LinearRing(ring).is_ccw else holes).append(ring)
    polygons = [Polygon(r) for r in shells]
    attached = [[] for _ in shells]
    for hole in holes:
        point = shapely.Point(hole[0])
        candidates = [i for i, p in enumerate(polygons) if p.covers(point)]
        if len(candidates) != 1:
            raise ValueError("AMBIGUOUS_EXACT_HOLE_PARENT")
        attached[candidates[0]].append(hole)
    result = [Polygon(shell, hs) for shell, hs in zip(shells, attached)]
    if any(not p.is_valid for p in result):
        raise ValueError("INVALID_EXACT_FACE_UNION")
    return result


def common_partition(env, seeds, neighbors, neighbor_ids, output, stage):
    seed_geometries = [g for _, g in seeds]
    seed_tree = shapely.STRtree(seed_geometries)
    neighbor_tree = shapely.STRtree(neighbors)
    print("common line noding", stage, len(seeds), "seeds", len(neighbors), "neighbors", flush=True)
    linework = shapely.union_all([env.boundary, *[g.boundary for g in seed_geometries], *[g.boundary for g in neighbors]])
    faces = list(shapely.polygonize(list(linework.geoms) if hasattr(linework, "geoms") else [linework]).geoms)
    by_family, by_neighbor = defaultdict(list), defaultdict(list)
    unmatched, numerical_faces = [], []
    for face in faces:
        pt = face.representative_point()
        if env.covers(pt):
            matches = [int(i) for i in seed_tree.query(pt) if seed_geometries[int(i)].covers(pt)]
            matched_families = {seeds[i][0] for i in matches}
            if len(matched_families) == 1:
                by_family[next(iter(matched_families))].append(face)
                continue
            candidates = matches or [int(i) for i in seed_tree.query(face.buffer(1e-12))
                                     if seed_geometries[int(i)].boundary.distance(face) <= 1e-12]
            boundaries = shapely.union_all([seed_geometries[i].boundary for i in candidates])
            distances = [shapely.Point(xy).distance(boundaries) for xy in shapely.get_coordinates(face)]
            width = 2 * face.area / face.length
            if candidates and width <= 1e-12 and max(distances, default=math.inf) <= 1e-12:
                chosen = min(candidates, key=lambda i: (seeds[i][0] is None, seeds[i][0] if seeds[i][0] is not None else i))
                by_family[seeds[chosen][0]].append(face)
                numerical_faces.append({"geometry": geometry(face), "areaDegrees2": face.area,
                    "effectiveWidthDegrees": width, "maximumVertexDistanceToOriginalCandidateBoundaryDegrees": max(distances),
                    "candidateFamilies": sorted({seeds[i][0] for i in candidates}, key=lambda i: -1 if i is None else i),
                    "recipientSourceIndex": seeds[chosen][0], "stage": stage,
                    "reason": "IEEE754 GEOS intersection face within existing 1e-12 numerical representation policy"})
            else:
                unmatched.append({"kind": "source-face-membership", "matches": matches, "geometry": geometry(face)})
        else:
            matches = [int(i) for i in neighbor_tree.query(pt) if neighbors[int(i)].covers(pt)]
            if len(matches) == 1:
                by_neighbor[neighbor_ids[matches[0]]].append(face)
    if unmatched:
        immutable(output + "/failed-membership-" + str(stage) + ".json", unmatched)
        raise ValueError("AMBIGUOUS_FINAL_PARTITION:" + str(len(unmatched)))
    return faces, by_family, by_neighbor, numerical_faces


def original_contacts_on_common_mesh(by_family, original, source_boundary_cache, require_original=True):
    residual_components = union_mesh_faces(by_family.get(None, []))
    boundary_lookup = {}
    for n, component in enumerate(residual_components):
        for a, b in each_segment(component):
            boundary_lookup[segment_key(a, b)] = n
    contacts = defaultdict(lambda: defaultdict(list))
    witnesses = defaultdict(list)
    for i, faces in by_family.items():
        if i is None:
            continue
        for face in faces:
            for a, b in each_segment(face):
                n = boundary_lookup.get(segment_key(a, b))
                if n is None:
                    continue
                if i not in source_boundary_cache:
                    source_boundary_cache[i] = segment_cover_index(each_segment(original[i]))
                witness = original_segment_witness(a, b, source_boundary_cache[i])
                if witness is None and require_original:
                    # A previous gameplay gain may touch this residual. It is
                    # never promoted to a fresh source contact / walking seed.
                    continue
                contacts[n][i].append(LineString([a, b]))
                witnesses[n].append({"sourceIndex": i, "meshSegment": [a, b], **(witness or {})})
    result = []
    for n, component in enumerate(residual_components):
        result.append((component, [(i, shapely.MultiLineString(values)) for i, values in sorted(contacts[n].items())], witnesses[n]))
    return result


def bounded_connected_family_remainders(by_family, original, ledger, source_boundary_cache):
    """Complete two observed Antu gain remainders, anchored to original contact.

    A previous gameplay gain supplies connectivity only. All distance bounds use
    the pinned original residual's finite raw-source contact, so this cannot
    advance by successively making new gains into new distance seeds.
    """
    if any(entry.get("stage") == "bounded-connected-family-cleanup" for entry in ledger):
        return None
    original_residual_id = "CHN:residual:2417e0987c06b9cb6eee554249348255b82a19a928e336d0d37b3b2fd9209ca9"
    scopes = [entry for entry in ledger if entry["residualId"] == original_residual_id and entry["stage"] == "pre-common-mesh"]
    if len(scopes) != 1:
        raise ValueError("BOUNDED_REMAINDER_ORIGINAL_SCOPE_CHANGED")
    scope_record = scopes[0]
    scope = shape(scope_record["geometry"])
    source_index = 118
    projection = scope_record["distanceProjection"]
    xs, ys = projection["xKmPerDegree"], projection["yKmPerDegree"]
    project = lambda g: affinity.scale(g, xfact=xs, yfact=ys, origin=(0, 0))
    original_contact = scope.boundary.intersection(original[source_index].boundary)
    contact_segments = [LineString([a, b]) for line in lines(original_contact)
                        for a, b in zip(list(line.coords), list(line.coords)[1:])]
    if not contact_segments:
        raise ValueError("BOUNDED_REMAINDER_WITHOUT_ORIGINAL_DISTANCE_CONTACT")
    expected = {
        "territory:catalog:71716e8984e7ae872bf439e9e06a8eb5e70d5432755e4d24276ffdb5572030eb",
        "territory:catalog:fa94335baf9331b792ca97a39a42f7c07391e50fcc29f73b8d02d450b198ab80"}
    audit = original_contacts_on_common_mesh(by_family, original, source_boundary_cache, require_original=False)
    fine_components = union_mesh_faces(by_family[source_index])
    gains, fallback, entries, selected_ids = defaultdict(list), [], [], set()
    for component, contacts, witnesses in audit:
        input_id = "territory:catalog:" + key({"country": "CHN", "family": None, "geometry": geometry(component)})
        if input_id not in expected:
            fallback.append(component)
            continue
        same_family_contacts = [contact for i, contact in contacts if i == source_index]
        if not same_family_contacts or any(i != source_index for i, _ in contacts):
            raise ValueError("BOUNDED_REMAINDER_EXISTING_FAMILY_CONTACT_CHANGED")
        contact = shapely.MultiLineString([line for g in same_family_contacts for line in lines(g)])
        positive_components = [p for p in fine_components if p.boundary.intersection(contact).length > 0 and p.intersection(original[source_index]).area > 0]
        if len(positive_components) != 1:
            raise ValueError("BOUNDED_REMAINDER_NOT_CONNECTED_TO_ONE_ORIGINAL_FINE_COMPONENT")
        receiving_component = positive_components[0]
        projected_points = [shapely.Point(p) for p in shapely.get_coordinates(project(component))]
        distance_choices = [(max(p.distance(project(segment)) for p in projected_points), n, segment)
                            for n, segment in enumerate(contact_segments)]
        maximum_distance, contact_index, distance_contact = min(distance_choices, key=lambda row: (row[0], row[1]))
        if maximum_distance > 10:
            raise ValueError("BOUNDED_REMAINDER_EXCEEDS_ORIGINAL_TEN_KM_BOUND")
        if any(shapely.Point(p).distance(receiving_component) > 1e-12 for p in distance_contact.coords):
            raise ValueError("ORIGINAL_DISTANCE_CONTACT_NOT_IN_CONNECTED_RECEIVING_FAMILY")
        outside = component.difference(scope)
        scope_delta = None
        if outside.area > 0:
            width = 2 * outside.area / outside.length
            scope_witnesses = boundary_point_certificate(scope, outside)
            if width > 1e-12:
                raise ValueError("BOUNDED_REMAINDER_OUTSIDE_ORIGINAL_SCOPE")
            outside_geometry = geometry(outside)
            scope_delta = {"geometry": outside_geometry, "geometrySha256WKB": hashlib.sha256(shape(outside_geometry).wkb).hexdigest(),
                "areaDegrees2": outside.area, "effectiveWidthDegrees": width,
                "originalBoundaryPointWitnesses": scope_witnesses, "certificateNumericalBoundDegrees": 1e-12,
                "reason": "Named existing 1e-12 straight-coast subdivision representation delta; no additional gameplay land beyond original residual scope"}
        family_witnesses = [{"coordinates": w["meshSegment"], "sourceIndex": source_index}
                            for w in witnesses if w["sourceIndex"] == source_index]
        gain = {"sourceIndex": source_index, "assignedPartGeometry": geometry(component), "areaKm2": area_km(component),
                "existingFamilyContactWitnesses": family_witnesses}
        entries.append({"residualId": "CHN:bounded-connected-remainder:" + key(geometry(component)),
            "stage": "bounded-connected-family-cleanup", "method": "positive-existing-family-contact-with-distance-still-anchored-to-original-source-contact",
            "inputRemainderTerritoryId": input_id, "geometry": geometry(component), "areaKm2": area_km(component),
            "originalResidualId": original_residual_id,
            "originalDistanceContact": {"sourceIndex": source_index, "coordinates": list(distance_contact.coords),
                "projection": projection, "maximumContactDistanceKm": 10, "maximumMeasuredWholePartDistanceKm": maximum_distance,
                "wholePartDistanceProof": "Distance to a finite segment is convex; maximum over polygon vertices bounds every point in its convex hull"},
            "originalResidualScopeNodingDelta": scope_delta,
            "receivingConnectedFamilyGeometrySha256WKB": hashlib.sha256(receiving_component.wkb).hexdigest(),
            "receivingFamilyOriginalCoreIntersectionAreaDegrees2": receiving_component.intersection(original[source_index]).area,
            "existingFamilyContactWitnesses": family_witnesses, "contacts": [source_index], "gains": [gain],
            "gameplayGainsUsedAsNewDistanceSeeds": False, "geometryAdjusted": True,
            "rawSourceArtifactGeometryUnmodified": True, "administrativeTruthClaim": False, "disposition": "gameplay-assigned"})
        gains[source_index].append(component)
        selected_ids.add(input_id)
    if selected_ids != expected:
        raise ValueError("BOUNDED_REMAINDER_PINNED_CASE_IDENTITIES_CHANGED")
    return gains, fallback, entries


def exclude_invented_outline_components(by_family, original_env, stage):
    """Remove only NEW connected cycles collapsed onto an original straight edge.

    No minimum island area is used. Every original national component is an
    explicit protected identity. A discarded cycle must have all coordinates
    within the existing numerical bound of one finite original outline segment,
    and zero width at that representation scale; its complete faces are ledgered.
    """
    all_rows = [(i, face) for i, faces in by_family.items() for face in faces]
    components = union_mesh_faces([face for _, face in all_rows])
    original_components = parts(original_env)
    outline = segment_cover_index(each_segment(original_env))
    excluded, to_remove = [], set()
    face_index = shapely.STRtree([face for _, face in all_rows])
    for component in components:
        width = 2 * component.area / component.length
        if width > 1e-12 or any(component.equals(p) for p in original_components):
            continue
        coords = [tuple(p) for p in shapely.get_coordinates(component.boundary)]
        values, index = outline
        bounds = component.bounds
        box = shapely.box(bounds[0] - 1e-12, bounds[1] - 1e-12, bounds[2] + 1e-12, bounds[3] + 1e-12)
        collapsed_on = None
        for n in sorted(index.query(box)):
            segment = values[int(n)]
            distances = [shapely.Point(p).distance(segment) for p in coords]
            if max(distances, default=math.inf) <= 1e-12:
                collapsed_on = (int(n), segment, distances)
                break
        if collapsed_on is None:
            continue
        # Exact segment incidence chooses the connected faces. Representative
        # points of these width~1e-16 cycles can round to either side of a coast.
        exterior_keys = {segment_key(a, b) for a, b in each_segment(component)}
        local_rows = [int(n) for n in face_index.query(component)]
        segments_to_faces = defaultdict(list)
        row_segments = {}
        for n in local_rows:
            row_segments[n] = {segment_key(a, b) for a, b in each_segment(all_rows[n][1])}
            for s in row_segments[n]:
                segments_to_faces[s].append(n)
        selected = {n for n in local_rows if row_segments[n] & exterior_keys}
        queue = list(selected)
        while queue:
            n = queue.pop()
            for s in row_segments[n]:
                if s in exterior_keys:
                    continue
                for adjacent in segments_to_faces[s]:
                    if adjacent not in selected:
                        selected.add(adjacent)
                        queue.append(adjacent)
        removed_faces = [all_rows[n][1] for n in sorted(selected)]
        removed_components = union_mesh_faces(removed_faces)
        removed_keys = {segment_key(a, b) for p in removed_components for a, b in each_segment(p)}
        if not selected or removed_keys != exterior_keys:
            raise ValueError("NUMERICAL_COMPONENT_FACE_TRACE_FAILED")
        for n in selected:
            i, face = all_rows[n]
            if i is not None and not any(other is not face for other in by_family[i]):
                raise ValueError("NUMERICAL_COMPONENT_WOULD_DELETE_UNIQUE_FINE_FAMILY")
        segment_n, segment, distances = collapsed_on
        excluded.append({"stage": stage, "method": "exclude-new-floating-cycle-collapsed-onto-original-finite-outline-segment",
            "geometry": geometry(component), "geometrySha256WKB": hashlib.sha256(component.wkb).hexdigest(),
            "areaDegrees2": component.area, "areaKm2": area_km(component), "effectiveWidthDegrees": width,
            "originalCanonicalIntersectionAreaDegrees2": component.intersection(original_env).area,
            "originalSegmentIndex": segment_n, "originalSegment": list(segment.coords),
            "originalBoundaryPointWitnesses": [{"coordinate": p, "originalSegment": list(segment.coords),
                "measuredDistanceDegrees": d, "maximumDistanceDegrees": 1e-12} for p, d in zip(coords, distances)],
            "certificateNumericalBoundDegrees": 1e-12, "originalNationalComponentDeleted": False,
            "rawSourceArtifactGeometryUnmodified": True, "administrativeTruthClaim": False,
            "affectedFaces": [{"sourceIndex": all_rows[n][0], "geometry": geometry(all_rows[n][1])} for n in sorted(selected)]})
        if component.intersection(original_env).area > 0:
            excluded[-1]["namedRepresentationException"] = {
                "id": "CHN:coast-collapsed-cycle:" + hashlib.sha256(component.wkb).hexdigest(),
                "reason": "New connected floating cycle collapsed onto one unchanged finite original coast segment. The explicitly measured nonzero intersection is a named straight-line representation corridor, not claimed as exact mathematical zero.",
                "maximumCoordinateDistanceDegrees": 1e-12, "originalFiniteSegment": list(segment.coords),
                "newlyCreatedCycle": True, "originalNationalComponentsBefore": len(original_components),
                "originalNationalComponentsAfter": len(components) - len(excluded)}
        to_remove.update(id(all_rows[n][1]) for n in selected)
    if to_remove:
        by_family = {i: [face for face in faces if id(face) not in to_remove] for i, faces in by_family.items()}
        print("excluded new floating outline components", stage, len(excluded), flush=True)
    if len(components) - len(excluded) != len(original_components):
        raise ValueError("UNEXPLAINED_NATIONAL_COMPONENT_CHANGE:" + str(len(components)) + ":" + str(len(excluded)))
    for entry in excluded:
        if "namedRepresentationException" in entry:
            entry["namedRepresentationException"]["originalNationalComponentsAfter"] = len(components) - len(excluded)
    return by_family, excluded


def exact_orientation(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def exact_ring_location(point, ring):
    """-1 outside, 0 on a finite edge, 1 inside; exact IEEE-input rationals."""
    winding = 0
    for a, b in zip(ring, ring[1:]):
        turn = exact_orientation(a, b, point)
        if turn == 0 and min(a[0], b[0]) <= point[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= point[1] <= max(a[1], b[1]):
            return 0
        if a[1] <= point[1] < b[1] and turn > 0:
            winding += 1
        elif b[1] <= point[1] < a[1] and turn < 0:
            winding -= 1
    return 1 if winding else -1


def original_source_pair_gap(raw, source, original_env):
    """One observed distribution-specific source gap, not a numeric exception.

    The aggregate GEOS union loses this ~0.004 m2 wedge. Its three coordinates
    already exist in the pinned original polygons. Keep them unchanged and
    account for the gap as an explicit gameplay gain, using exact rational
    orientation tests to exclude every original fine interior from the triangle.
    """
    raw_identity = pin(RAW)
    required_sha256 = "3cc71d6cd23e7dbb5646422b40dd92a7a74d8779f340eb9377158c961dec310e"
    if raw_identity["sha256"] != required_sha256:
        raise ValueError("SOURCE_PAIR_GAP_CASE_REQUIRES_EXACT_PINNED_DISTRIBUTION")
    receiver, neighbor = 723, 2854
    receiver_id, neighbor_id = "62558664B29577970904240", "62558664B55975392964671"
    if raw["features"][receiver]["properties"]["shapeID"] != receiver_id or raw["features"][neighbor]["properties"]["shapeID"] != neighbor_id:
        raise ValueError("SOURCE_PAIR_GAP_CASE_FEATURE_INDEX_CHANGED")
    receiver_ring = raw["features"][receiver]["geometry"]["coordinates"][0]
    neighbor_ring = raw["features"][neighbor]["geometry"]["coordinates"][0]
    a, b, q = tuple(receiver_ring[62]), tuple(receiver_ring[63]), tuple(neighbor_ring[2])
    if a != tuple(neighbor_ring[3]):
        raise ValueError("SOURCE_PAIR_GAP_NATIVE_SHARED_ENDPOINT_CHANGED")
    triangle = Polygon([a, q, b])
    if not triangle.is_valid or not original_env.covers(triangle):
        raise ValueError("SOURCE_PAIR_GAP_NOT_WITHIN_FIXED_CHN")
    rational = lambda p: tuple(Fraction(float(v)) for v in p)
    vertices = [rational(p) for p in [a, q, b]]
    rational_ring = [*vertices, vertices[0]]
    center = tuple(sum(p[k] for p in vertices) / 3 for k in [0, 1])
    exact_area = abs(exact_orientation(*vertices)) / 2
    if exact_area == 0:
        raise ValueError("SOURCE_PAIR_GAP_COLLAPSED")
    raw_tree = shapely.STRtree(source)
    candidates = sorted(int(i) for i in raw_tree.query(triangle))
    checks = []
    triangle_edges = list(zip(rational_ring, rational_ring[1:]))
    for i in candidates:
        g = raw["features"][i]["geometry"]
        polygons = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        center_inside = False
        vertex_inside = False
        edge_crosses = False
        for polygon in polygons:
            rings = [[rational(p) for p in ring] for ring in polygon]
            if exact_ring_location(center, rings[0]) == 1 and not any(exact_ring_location(center, hole) >= 0 for hole in rings[1:]):
                center_inside = True
            for ring in rings:
                for p in ring[:-1]:
                    if exact_ring_location(p, rational_ring) == 1:
                        vertex_inside = True
                for c, d in zip(ring, ring[1:]):
                    midpoint = ((c[0] + d[0]) / 2, (c[1] + d[1]) / 2)
                    if exact_ring_location(midpoint, rational_ring) == 1:
                        edge_crosses = True
                    for e, f in triangle_edges:
                        if exact_orientation(c, d, e) * exact_orientation(c, d, f) < 0 and exact_orientation(e, f, c) * exact_orientation(e, f, d) < 0:
                            edge_crosses = True
        if center_inside or vertex_inside or edge_crosses:
            raise ValueError("SOURCE_PAIR_GAP_INTERSECTS_ORIGINAL_FINE_INTERIOR:" + str(i))
        checks.append({"sourceIndex": i, "sourceFeatureId": raw["features"][i]["properties"]["shapeID"],
            "triangleRationalBarycenterInsideOriginal": center_inside,
            "originalVertexStrictlyInsideTriangle": vertex_inside,
            "originalEdgeProperlyCrossesOpenTriangle": edge_crosses})
    contact = {"sourceIndex": receiver, "meshSegment": [a, b], "originalSourceSegment": [a, b],
               "originalSegmentIndex": 62, "maximumEndpointDistanceDegrees": 0}
    record = {"residualId": "CHN:exact-source-pair-gap:" + key(geometry(triangle)),
        "stage": "exact-source-pair-gap", "method": "pinned-original-source-pair-gap-gameplay-closure",
        "geometry": geometry(triangle), "geometrySha256WKB": hashlib.sha256(triangle.wkb).hexdigest(),
        "areaDegrees2": triangle.area, "areaKm2": area_km(triangle),
        "exactAreaDegrees2": {"numerator": str(exact_area.numerator), "denominator": str(exact_area.denominator)},
        "originalSourceFeatureIds": [receiver_id, neighbor_id], "receivingSourceFeatureId": receiver_id,
        "rawSource": raw_identity, "nativeCoordinateReferences": [
            {"label": "A", "sourceIndex": receiver, "sourceFeatureId": receiver_id, "componentIndex": 0, "ringIndex": 0, "vertexIndex": 62, "coordinate": a},
            {"label": "Q", "sourceIndex": neighbor, "sourceFeatureId": neighbor_id, "componentIndex": 0, "ringIndex": 0, "vertexIndex": 2, "coordinate": q},
            {"label": "B", "sourceIndex": receiver, "sourceFeatureId": receiver_id, "componentIndex": 0, "ringIndex": 0, "vertexIndex": 63, "coordinate": b}],
        "contactWitnesses": [contact], "contacts": [receiver, neighbor],
        "gameplayClosingChord": {"coordinates": [q, b], "administrativeTruthClaim": False,
            "method": "Explicit gameplay closing chord between native source endpoints, entirely within the rationally certified source-free triangle; not claimed as an original administrative edge"},
        "noOtherOriginalFineInteriorCertificate": {"method": "Exact Fraction arithmetic over the binary IEEE coordinate values; outside barycenter, no original vertex inside and no original edge properly crossing the open triangle", "bboxCandidateSources": checks},
        "augmentOriginalResidual": True, "aggregateGEOSResidualMayMissThisExactSourceGap": True,
        "disposition": "gameplay-assigned", "geometryAdjusted": True,
        "rawSourceArtifactGeometryUnmodified": True, "rawCoordinatesUnchanged": True, "administrativeTruthClaim": False,
        "gains": [{"sourceIndex": receiver, "assignedPartGeometry": geometry(triangle), "areaKm2": area_km(triangle), "contactWitnesses": [contact]}]}
    return receiver, triangle, record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="data/derived/chn-2020/work")
    args = parser.parse_args()
    decision = read("reports/chn-2020/source-decision.json")
    raw = read(RAW)
    baseline = read(BASELINE)
    source = [shape(f["geometry"]) for f in raw["features"]]
    if any(not g.is_valid for g in source):
        raise ValueError("INVALID_RAW_SOURCE")
    old_records = {r["id"]: r for r in baseline["records"]}
    old_features = {f["id"]: f for f in baseline["features"]}
    old_china = [f for f in baseline["features"] if old_records[f["id"]]["countryId"] == "CHN"]
    original_env = shapely.union_all([shape(f["geometry"]) for f in old_china])
    # The active edge mesh already contains the exact PRK-side shared nodes.
    # Coarse CHN polygon rings omit some of those collinear nodes. Reconstruct
    # the same physical outline from authoritative active incidences first.
    env_segments = []
    for edge in baseline["edges"]:
        left = old_records[edge["leftTerritoryId"]]["countryId"] == "CHN"
        right = bool(edge["rightTerritoryId"] and old_records[edge["rightTerritoryId"]]["countryId"] == "CHN")
        if left != right:
            c = edge["geometry"]["coordinates"]
            if right:
                c = list(reversed(c))
            env_segments.extend(zip(c, c[1:]))
    env_parts = union_mesh_faces([], env_segments)
    env = env_parts[0] if len(env_parts) == 1 else shapely.MultiPolygon(env_parts)
    original_outline_index = segment_cover_index(each_segment(original_env))
    if any(not covered_by_original_segment(a, b, original_outline_index) for a, b in each_segment(env)):
        raise ValueError("ACTIVE_EDGE_ENVELOPE_PHYSICAL_CHANGE")
    if len(parts(env)) != len(parts(original_env)) or sum(len(p.interiors) for p in parts(env)) != sum(len(p.interiors) for p in parts(original_env)):
        raise ValueError("ACTIVE_EDGE_ENVELOPE_COMPONENT_CHANGE")
    print("clip source", len(source), flush=True)
    clipped = [g.intersection(env) for g in source]
    union = shapely.union_all(clipped)
    residual = env.difference(union)
    tree = shapely.STRtree(clipped)
    gains, fallback, ledger = residual_partition(residual, clipped, tree)
    gap_receiver, exact_gap, gap_record = original_source_pair_gap(raw, source, original_env)
    gains[gap_receiver].append(exact_gap)
    ledger.append(gap_record)
    print("contact partition done", len(ledger), "fallback", len(fallback), flush=True)
    # One final common line arrangement creates fills, macro/country/coast edges.
    families = [(i, shapely.union_all([g, *gains.get(i, [])])) for i, g in enumerate(clipped) if not g.is_empty]
    seeds = [(i, g) for i, g in families] + [(None, p) for p, _ in fallback]
    neighbor_ids = set()
    for edge in baseline["edges"]:
        a, b = edge["leftTerritoryId"], edge["rightTerritoryId"]
        if b and old_records[a]["countryId"] != old_records[b]["countryId"]:
            if old_records[a]["countryId"] == "CHN":
                neighbor_ids.add(b)
            if old_records[b]["countryId"] == "CHN":
                neighbor_ids.add(a)
    neighbor_ids = sorted(neighbor_ids)
    neighbor_segments = defaultdict(list)
    for edge in baseline["edges"]:
        for old_id, reverse in [(edge["leftTerritoryId"], False), (edge["rightTerritoryId"], True)]:
            if old_id in neighbor_ids:
                c = edge["geometry"]["coordinates"]
                if reverse:
                    c = list(reversed(c))
                neighbor_segments[old_id].extend(zip(c, c[1:]))
    neighbors = []
    for old_id in neighbor_ids:
        ps = union_mesh_faces([], neighbor_segments[old_id])
        neighbors.append(ps[0] if len(ps) == 1 else shapely.MultiPolygon(ps))
    source_boundary_cache = {}
    cleanup_stages, numerical_face_stages, carried_numerical_faces = [], [], []
    for stage in range(3):
        faces, by_family, by_neighbor, numerical_faces = common_partition(env, seeds, neighbors, neighbor_ids, args.output, stage)
        numerical_face_stages.append({"stage": stage, "faces": numerical_faces})
        audit = original_contacts_on_common_mesh(by_family, clipped, source_boundary_cache)
        cleanable = [(r, contacts, witnesses) for r, contacts, witnesses in audit if contacts]
        print("common-mesh residual audit", stage, len(audit), "components", len(cleanable), "with original contact", flush=True)
        if not cleanable:
            completion = bounded_connected_family_remainders(by_family, clipped, ledger, source_boundary_cache)
            if completion is not None:
                if stage == 2:
                    raise ValueError("BOUNDED_COMPLETION_REQUIRES_ANOTHER_COMMON_PARTITION")
                added, next_fallback, entries = completion
                ledger.extend(entries)
                cleanup_stages.append({"stage": stage, "method": "bounded-connected-family-cleanup",
                    "inputResidualComponents": len(audit), "cleanableOriginalContactComponents": 0,
                    "completedConnectedFamilyRemainders": len(entries),
                    "assignedAreaKm2": sum(entry["areaKm2"] for entry in entries),
                    "gameplayGainsUsedAsNewDistanceSeeds": False})
                carried_numerical_faces.extend(entry for entry in numerical_faces if entry["recipientSourceIndex"] is not None)
                seeds = [(i, p) for i, ps in by_family.items() if i is not None for p in union_mesh_faces(ps)]
                seeds.extend((i, p) for i, values in added.items() for p in values)
                seeds.extend((None, p) for p in next_fallback)
                continue
            break
        if stage == 2:
            immutable(args.output + "/failed-post-mesh-contacts.json", [{"geometry": geometry(r), "contactWitnesses": witnesses} for r, _, witnesses in cleanable])
            raise ValueError("CLEANABLE_ORIGINAL_CONTACT_REMAINS_AFTER_THREE_COMMON_PARTITIONS")
        gained = defaultdict(list)
        next_fallback = []
        assigned_area = 0
        for r, contacts, witnesses in audit:
            if not contacts:
                next_fallback.append(r)
                continue
            added, remains, entries = residual_partition(r, clipped, tree,
                explicit_contacts=(contacts, witnesses), stage="post-common-mesh-residual-cleanup:" + str(stage),
                source_boundary_cache=source_boundary_cache)
            if not any(added.values()):
                immutable(args.output + "/failed-unassignable-original-contact.json", entries)
                raise ValueError("ORIGINAL_COMMON_MESH_CONTACT_NOT_CLEANED")
            for i, values in added.items():
                gained[i].extend(values)
                assigned_area += sum(area_km(p) for p in values)
            next_fallback.extend(p for p, _ in remains)
            ledger.extend(entries)
        cleanup_stages.append({"stage": stage, "inputResidualComponents": len(audit), "cleanableOriginalContactComponents": len(cleanable),
            "assignedAreaKm2": assigned_area, "remainingComponentsBeforeRenoding": len(next_fallback),
            "seedPolicy": "Only exact common-mesh contacts traced to the original clipped source boundary, never previous gameplay gains"})
        carried_numerical_faces.extend(entry for entry in numerical_faces if entry["recipientSourceIndex"] is not None)
        # Same-family seed pieces may remain separate until the common noding
        # pass. This avoids another GEOS union recomputing existing fine nodes.
        seeds = [(i, p) for i, ps in by_family.items() if i is not None for p in union_mesh_faces(ps)]
        seeds.extend((i, p) for i, values in gained.items() for p in values)
        seeds.extend((None, p) for p in next_fallback)
    by_family, excluded_numerical_components = exclude_invented_outline_components(by_family, original_env, stage)
    # Superseded source-free numerical faces are accounted for by a later
    # explicit residual gain, rather than falsely claiming they remain None.
    numerical_faces = list({(entry["recipientSourceIndex"], key(entry["geometry"])): entry
        for entry in [*carried_numerical_faces, *numerical_faces]}.values())
    excluded_geometries = [shape(entry["geometry"]) for entry in excluded_numerical_components]
    if excluded_geometries:
        numerical_faces = [entry for entry in numerical_faces if not any(shape(entry["geometry"]).equals(g) for g in excluded_geometries)]
    # Dissolving exact labeled faces cancels obsolete coarse province cuts.
    cells = []
    old_china_geometries = [shape(f["geometry"]) for f in old_china]
    old_china_tree = shapely.STRtree(old_china_geometries)
    print("labelled faces", len(faces), "numerical faces", len(numerical_faces), flush=True)
    for i, ps in sorted(by_family.items(), key=lambda x: -1 if x[0] is None else x[0]):
        for p in union_mesh_faces(ps):
            props = {"countryId": "CHN", "sourceId": SOURCE_ID if i is not None else "canonical-country-p0",
                     "sourceFeatureId": raw["features"][i]["properties"]["shapeID"] if i is not None else None,
                     "fineSourceIdentity": {"sourceId": SOURCE_ID, "sourceFeatureId": raw["features"][i]["properties"]["shapeID"]} if i is not None else None,
                     "name": raw["features"][i]["properties"]["shapeName"] if i is not None else "CHN source-unassigned baseline land",
                     "sourceVersion": "9469f09592ced973a3448cf66b6100b741b64c0d/CHN-ADM3-62558664",
                     "adminLevel": 3 if i is not None else None, "unresolvedFineSourceAssignment": i is None,
                     "boundaryBasis": "administrative" if i is not None else "canonical-country-residual"}
            geom = geometry(p)
            props["baselineCellIds"] = sorted(old_china[int(k)]["id"] for k in old_china_tree.query(p)
                                               if p.intersection(old_china_geometries[int(k)]).area > 0)
            if not props["baselineCellIds"]:
                nearby = [int(k) for k in old_china_tree.query(p.buffer(1e-12))
                          if p.distance(old_china_geometries[int(k)]) <= 1e-12]
                width = 2 * p.area / p.length
                if not nearby or width > 1e-12:
                    immutable(args.output + "/failed-lineage.json", {"geometry": geom, "width": width, "nearby": nearby})
                    raise ValueError("CELL_WITHOUT_BASELINE_LINEAGE")
                props["baselineCellIds"] = sorted(old_china[k]["id"] for k in nearby)
                props["numericalLineageException"] = {"reason": "Floating common-union face on existing seed border", "effectiveWidthDegrees": width,
                    "maximumBaselineDistanceDegrees": max(shapely.Point(xy).distance(shapely.union_all([old_china_geometries[k] for k in nearby])) for xy in shapely.get_coordinates(p))}
            cell_id = "territory:catalog:" + key({"country": "CHN", "family": props["fineSourceIdentity"], "geometry": geom})
            cells.append({"type": "Feature", "id": cell_id, "properties": props, "geometry": geom})
    # Add only collinear subdivisions to neighboring geometry. No neighboring IDs change.
    neighbor_features = []
    numeric_exceptions = []
    print("cells assembled", len(cells), flush=True)
    for old_id in neighbor_ids:
        polygons = union_mesh_faces(by_neighbor[old_id])
        g = polygons[0] if len(polygons) == 1 else shapely.MultiPolygon(polygons)
        old = shape(old_features[old_id]["geometry"])
        diff = old.symmetric_difference(g).area
        displacement = old.boundary.hausdorff_distance(g.boundary)
        witnesses = boundary_point_certificate(old, g)
        reverse_witnesses = boundary_point_certificate(g, old)
        old_boundary_index = segment_cover_index(each_segment(old))
        if any(not covered_by_original_segment(a, b, old_boundary_index) for a, b in each_segment(g)):
            raise ValueError("NEIGHBOR_SEGMENT_WITHOUT_ORIGINAL_STRAIGHT_SEGMENT:" + old_id)
        numeric_exceptions.append({"id": old_id, "reason": "GEOS intersection nodes on unchanged baseline straight border segments",
                                   "maximumSymmetricDifferenceAreaDegreesSquared": diff,
                                   "maximumBoundaryDisplacementDegrees": 1e-12,
                                   "measuredSymmetricDifferenceAreaDegreesSquared": diff,
                                   "measuredBoundaryDisplacementDegrees": displacement,
                                   "certificateNumericalBoundDegrees": 1e-12,
                                   "originalBoundaryPointWitnesses": witnesses,
                                   "removedOriginalPointWitnesses": reverse_witnesses,
                                   "certificateMethod": "Every inserted point and delivered edge independently traced to a finite original segment; removed original points traced to the delivered boundary. Existing numerical bound is unchanged, including cases whose generator metric rounds to zero."})
        if displacement > 1e-10 or diff > 1e-10:
            raise ValueError("NEIGHBOR_PHYSICAL_CHANGE:" + old_id)
        neighbor_features.append({**old_features[old_id], "geometry": geometry(g)})
    original_national_parts = union_mesh_faces(old_china_geometries)
    original_national = original_national_parts[0] if len(original_national_parts) == 1 else shapely.MultiPolygon(original_national_parts)
    actual_national_parts = union_mesh_faces([shape(f["geometry"]) for f in cells])
    actual_national = actual_national_parts[0] if len(actual_national_parts) == 1 else shapely.MultiPolygon(actual_national_parts)
    national_diff = original_national.symmetric_difference(actual_national).area
    numeric_exceptions.append({"id": "CHN:national-union", "reason": "All delivered national outline subdivisions individually traced to the unchanged original finite outline segments",
        "maximumSymmetricDifferenceAreaDegreesSquared": national_diff,
        "measuredSymmetricDifferenceAreaDegreesSquared": national_diff,
        "maximumBoundaryDisplacementDegrees": 1e-12,
        "measuredBoundaryDisplacementDegrees": original_national.boundary.hausdorff_distance(actual_national.boundary),
        "certificateNumericalBoundDegrees": 1e-12,
        "originalBoundaryPointWitnesses": boundary_point_certificate(original_national, actual_national),
        "removedOriginalPointWitnesses": boundary_point_certificate(actual_national, original_national),
        "originalComponents": len(original_national_parts), "actualComponents": len(actual_national_parts),
        "originalComponentRetainedInteriorWitnesses": [{"originalComponentIndex": i,
            "originalGeometrySha256WKB": hashlib.sha256(p.wkb).hexdigest(),
            "coordinate": list(p.representative_point().coords[0]),
            "retained": actual_national.covers(p.representative_point())} for i, p in enumerate(original_national_parts)]})
    if len(actual_national_parts) != len(original_national_parts) or not all(w["retained"] for w in numeric_exceptions[-1]["originalComponentRetainedInteriorWitnesses"]):
        raise ValueError("ORIGINAL_NATIONAL_COMPONENT_IDENTITY_NOT_RETAINED")
    # Incidence from the exact same final polygon mesh. Retained unrelated edges stay byte exact.
    all_features = cells + neighbor_features
    print("neighbors reconstructed", len(neighbor_features), flush=True)
    segments = defaultdict(list)
    for f in all_features:
        for a, b in each_segment(shape(f["geometry"])):
            segments[segment_key(a, b)].append((f["id"], 1 if a < b else -1))
    groups = defaultdict(list)
    china_ids = {f["id"] for f in cells}
    unpaired = []
    # A whole-country line.buffer(1e-12) collapses to empty under GEOS's
    # envelope-based buffer arithmetic. Trace each new segment to a specific
    # unchanged original segment instead; convex distance bounds its entirety.
    outline_guard = segment_cover_index(each_segment(env))
    land_segments = []
    for e in baseline["edges"]:
        if e["rightTerritoryId"] and (old_records[e["leftTerritoryId"]]["countryId"] == "CHN") != (old_records[e["rightTerritoryId"]]["countryId"] == "CHN"):
            c = e["geometry"]["coordinates"]
            land_segments.extend(zip(c, c[1:]))
    land_border_guard = segment_cover_index(land_segments)
    directions = {}
    for (a, b), incidences in segments.items():
        ids = sorted(set(i for i, _ in incidences))
        if not china_ids.intersection(ids):
            continue
        if len(ids) > 2:
            raise ValueError("MULTIPLE_MESH_SIDES")
        side = [d for i, d in incidences if i == ids[0]]
        if len(side) != 1 or len(ids) == 2 and len(set(d for _, d in incidences)) != 2:
            raise ValueError("INCONSISTENT_ORIENTED_MESH")
        directions[(tuple(ids), segment_key(a, b))] = side[0]
        if len(ids) == 1 and not covered_by_original_segment(a, b, outline_guard):
            unpaired.append({"ids": ids, "coordinates": [a, b]})
        if len(ids) == 1 and covered_by_original_segment(a, b, land_border_guard):
            unpaired.append({"ids": ids, "coordinates": [a, b], "reason": "baseline land border must have both incidences"})
        groups[tuple(ids)].append(LineString([a, b]))
    if unpaired:
        immutable(args.output + "/unpaired.json", unpaired)
        raise ValueError("UNPAIRED_INTERIOR_SEGMENTS:" + str(len(unpaired)))
    edges = []
    for ids, ls in sorted(groups.items()):
        merged = shapely.line_merge(shapely.MultiLineString(ls))
        for line in lines(merged):
            coords = list(line.coords)
            first = segment_key(tuple(coords[0]), tuple(coords[1]))
            intended = directions[(ids, first)]
            if (1 if tuple(coords[0]) < tuple(coords[1]) else -1) != intended:
                coords.reverse()
            e = {"leftTerritoryId": ids[0], "rightTerritoryId": ids[1] if len(ids) == 2 else None,
                 "geometry": {"type": "LineString", "coordinates": coords}}
            e["id"] = "edge:operational:" + key(e)
            edges.append(e)
    normalized = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {
        "countryId": "CHN", "sourceId": SOURCE_ID, "sourceFeatureId": f["properties"]["shapeID"],
        "sourceParentId": None, "name": f["properties"]["shapeName"]}, "geometry": f["geometry"]} for f in raw["features"]]}
    normalized_pin = immutable("data/raw/chn-2020/normalized-boundaries.geojson", normalized)
    source_lock = {"schemaVersion": "incremental-country-source-lock-v1", "countryId": "CHN", "normalizedCrs": "EPSG:4326",
                   "sources": [{"sourceId": SOURCE_ID, "url": "https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09592ced973a3448cf66b6100b741b64c0d/releaseData/gbOpen/CHN/ADM3/geoBoundaries-CHN-ADM3.geojson",
                                "version": "9469f09592ced973a3448cf66b6100b741b64c0d/CHN-ADM3-62558664", "adminLevel": 3,
                                "boundaryBasis": "administrative", "temporalCoverage": "metadata represented 2017; source XML proves processing in August 2021; mixed/uncertified vintage",
                                "scenarioDateCaveat": "Experimental 2020-01-01 scenario only. Not certified exact 2020 or wholly 2017 administrative boundaries. No unverified historical edits.",
                                "originalCrs": "OGC:CRS84 longitude,latitude; no datum/GCJ02/BD09 conversion",
                                "license": {"name": "ODbL 1.0 source database; geoBoundaries distribution CC BY 4.0",
                                            "url": "https://opendatacommons.org/licenses/odbl/1-0/", "redistributionAllowed": True,
                                            "attribution": "© OpenStreetMap contributors / Lee Beryman, Wambacher; geoBoundaries / William & Mary geoLab, Runfola et al. (2020). Adapted database offered under ODbL 1.0; raw source retained. https://www.openstreetmap.org/copyright"}, "artifact": pin(RAW)}],
                   "normalizedInput": normalized_pin, "preprocessing": {"description": "Property-only normalization; all original source coordinates/components/holes and distributor shapeID preserved. Offline gameplay partition separately clips to the unchanged active CHN envelope and records residual gains.", "code": [pin("scripts/chn-2020/prepare-china.py")]},
                   "decision": pin("reports/chn-2020/source-decision.json"), "actualFeatures": len(raw["features"])}
    source_lock_pin = immutable("data/source-locks/chn-2020/CHN-" + key(source_lock)[:20] + ".json", source_lock)
    result = {"schemaVersion": "chn-incremental-geometry-v1", "cells": sorted(cells, key=lambda f: f["id"]),
              "baseline": pin(BASELINE), "sourceDecision": pin("reports/chn-2020/source-decision.json"),
              "baselineEnvelopeNoding": {"method": "Exact directed cancellation of existing active country/coast edge incidences; unchanged original segments individually traced at existing 1e-12 numerical bound",
                "originalGeometryHash": key(geometry(original_env)), "nodedGeometryHash": key(geometry(env)),
                "symmetricDifferenceAreaDegrees2": original_env.symmetric_difference(env).area,
                "originalComponents": len(parts(original_env)), "nodedComponents": len(parts(env))},
              "neighborFeatures": sorted(neighbor_features, key=lambda f: f["id"]), "edges": sorted(edges, key=lambda e: e["id"]),
              "sourceLock": source_lock_pin, "normalized": normalized_pin,
              "numericExceptions": numeric_exceptions,
              "numericalFaces": numerical_faces,
              "numericalFaceStages": numerical_face_stages,
              "postCommonMeshCleanup": cleanup_stages,
              "numericalComponentExclusions": excluded_numerical_components,
              "residuals": ledger,
              "sourceTrace": [{"sourceFeatureId": f["properties"]["shapeID"], "rawComponents": len(parts(g)),
                               "intersectingEnvelopeComponents": len(parts(c)), "outsideEnvelopeAreaKm2": area_km(g.difference(env)),
                               "inEnvelopeAreaKm2": area_km(c)} for f, g, c in zip(raw["features"], source, clipped)],
              "evidence": {"rawFeatures": len(source), "rawVertices": int(shapely.count_coordinates(source)),
                           "cells": len(cells), "edges": len(edges), "vertices": int(shapely.count_coordinates([shape(f["geometry"]) for f in cells])),
                           "faces": len(faces), "neighborsNoded": len(neighbor_ids), "residualAreaKm2": area_km(residual),
                           "geometryAdjusted": True, "rawSourceArtifactGeometryUnmodified": True, "administrativeTruthClaim": False,
                           "sourceUnionInsideBaselineAreaKm2": area_km(union), "baselineAreaKm2": area_km(env),
                           "sourceOutsideGameTerritoryAutoIncorporated": False, "gridGenerated": False,
                           "tools": {"shapely": shapely.__version__, "geos": shapely.geos_version_string}}}
    out = immutable(args.output + "/geometry.json", result)
    immutable(args.output + "/cells.geojson", {"type": "FeatureCollection", "features": result["cells"]})
    immutable(args.output + "/numeric-exceptions.json", numeric_exceptions)
    print(json.dumps({"output": out, **result["evidence"]}), flush=True)


if __name__ == "__main__":
    main()
