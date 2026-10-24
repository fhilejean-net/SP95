#!/usr/bin/env python3
"""Packs the Hyundai i20 N Rally2 source model into a web-ready GLB.

The Sketchfab export is a display piece: two cars parked side by side on an
8.4 m platform, every material merged across both bodies, the wheels welded
into the shell, 4096 px textures and tangents for a normal map that does not
exist. three.js also dropped KHR_materials_pbrSpecularGlossiness, so the
materials would arrive untextured.

What this does:

  * drops the platform and the second car,
  * separates the four wheels into their own nodes (hub-centred, axle on X)
    so the game can spin and steer them; brake calipers stay with the body,
  * converts spec/gloss materials to metallic/roughness,
  * drops TANGENT attributes (nothing uses them),
  * re-encodes the textures at half resolution,
  * writes a Y-up, +Z-forward GLB centred on the wheelbase.

Run from the repository root: python3 scripts/convert-i20.py
"""

from __future__ import annotations

import collections
import io
import json
import math
import os
import struct
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "assets", "cars", "hyundai-i20-source")
OUTPUT = os.path.join(ROOT, "public", "models", "cars", "i20n.glb")

PLATFORM_MATERIALS = {"Platform", "platforma_cray", "Default_Material"}
# Fixed to the upright, not to the spinning wheel.
NON_ROTATING = {"Matte__FFFF0000__spec"}

# Hand-tuned stand-ins for the spec/gloss pairs: (metallic, roughness).
PBR = {
    "00576200__env_4_spec": (0.0, 0.22),
    "00d44fc0__spec": (0.0, 0.6),
    "Matte__FF000000__spec": (0.0, 0.55),
    "Matte__FF808080__env_4_spec": (0.35, 0.24),
    "Matte__FFFF0000__spec": (0.1, 0.45),
    "New_Material": (0.15, 0.28),
    "details": (0.05, 0.55),
    "diffuse__env_4_spec": (0.1, 0.3),
    "illum__env_4_spec_trans": (0.0, 0.15),
}

# Car A of the diorama, in world (Y-up) metres, measured from the geometry.
CAR_MIN_X = -0.30
HUBS = {
    "FL_WHEEL": (-2.375, 0.31, -1.14),
    "FR_WHEEL": (-0.64, 0.31, -1.14),
    "RL_WHEEL": (-2.375, 0.31, 1.45),
    "RR_WHEEL": (-0.64, 0.31, 1.45),
}
# Wheel parts fit inside this cylinder around a hub.
WHEEL_HALF_WIDTH = 0.17
WHEEL_RADIUS = 0.345
# Re-centre the car on its wheelbase midpoint and its centreline.
CENTER = (-1.5075, 0.0, 0.155)

CT = {5121: ("B", 1), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


# --- Reading ---------------------------------------------------------------


def read_accessor(doc: dict, binary: bytes, index: int) -> list[tuple[float, ...]]:
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    fmt, size = CT[accessor["componentType"]]
    width = NC[accessor["type"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", size * width)
    pattern = "<" + fmt * width
    return [
        struct.unpack_from(pattern, binary, start + i * stride)
        for i in range(accessor["count"])
    ]


def rotation_matrix(quat: tuple[float, float, float, float]) -> list[list[float]]:
    x, y, z, w = quat
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]


def mat_mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def mat_vec(matrix, vector):
    return [sum(matrix[i][k] * vector[k] for k in range(3)) for i in range(3)]


def world_matrices(doc: dict) -> dict[int, list[list[float]]]:
    out: dict[int, list[list[float]]] = {}
    nodes = doc["nodes"]

    def walk(index: int, parent):
        rotation = nodes[index].get("rotation")
        matrix = mat_mul(parent, rotation_matrix(rotation)) if rotation else parent
        out[index] = matrix
        for child in nodes[index].get("children", []):
            walk(child, matrix)

    identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    for root in doc["scenes"][doc.get("scene", 0)]["nodes"]:
        walk(root, identity)
    return out


class UnionFind:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, a: int) -> int:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def weld(positions: list[tuple[float, ...]], indices: list[int]) -> tuple[list[int], list[tuple[float, ...]]]:
    """Maps every vertex to a welded representative (1e-4 m grid)."""
    lookup: dict[tuple[int, int, int], int] = {}
    unique: list[tuple[float, ...]] = []
    owner = [0] * len(positions)
    for index, position in enumerate(positions):
        key = (round(position[0] * 10000), round(position[1] * 10000), round(position[2] * 10000))
        if key not in lookup:
            lookup[key] = len(unique)
            unique.append(position)
        owner[index] = lookup[key]
    uf = UnionFind(len(unique))
    for t in range(0, len(indices), 3):
        uf.union(owner[indices[t]], owner[indices[t + 1]])
        uf.union(owner[indices[t + 1]], owner[indices[t + 2]])
    return [uf.find(o) for o in owner], unique


def classify(root: int, points: list[tuple[float, ...]], material: str) -> str:
    """One of the four wheels, the body, or the second car (dropped)."""
    xs = [p[0] for p in points]
    if (min(xs) + max(xs)) / 2 >= CAR_MIN_X:
        return "drop"
    # Calipers are bolted to the upright: they must not spin with the wheel.
    if material in NON_ROTATING:
        return "body"
    for name, (hx, hy, hz) in HUBS.items():
        if all(
            abs(p[0] - hx) <= WHEEL_HALF_WIDTH
            and math.dist((p[1], p[2]), (hy, hz)) <= WHEEL_RADIUS
            for p in points
        ):
            return name
    return "body"


def encode_image(path: str) -> tuple[bytes, str]:
    with open(path, "rb") as f:
        image = Image.open(io.BytesIO(f.read()))
    width, height = image.size
    longest = max(width, height)
    target = 2048 if longest >= 4096 else 1024 if longest >= 2048 else longest
    if target < longest:
        image = image.resize(
            (round(width * target / longest), round(height * target / longest)),
            Image.LANCZOS,
        )
    out = io.BytesIO()
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        image.convert("RGBA").save(out, format="PNG", optimize=True)
        mime = "image/png"
    else:
        image.convert("RGB").save(out, format="JPEG", quality=88, optimize=True, progressive=True)
        mime = "image/jpeg"
    return out.getvalue(), mime


# --- Writing ---------------------------------------------------------------


class Builder:
    def __init__(self) -> None:
        self.binary = bytearray()
        self.views: list[dict] = []
        self.accessors: list[dict] = []

    def _view(self, payload: bytes, target: int | None = None) -> int:
        while len(self.binary) % 4:
            self.binary.append(0)
        offset = len(self.binary)
        self.binary.extend(payload)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        if target:
            view["target"] = target
        self.views.append(view)
        return len(self.views) - 1

    def floats(self, values: list[float], width: int, bounds: bool = False) -> int:
        payload = struct.pack("<" + "f" * len(values), *values)
        view = self._view(payload, 34962)
        points = [values[i : i + width] for i in range(0, len(values), width)]
        accessor = {
            "bufferView": view,
            "componentType": 5126,
            "count": len(points),
            "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4"}[width],
        }
        if bounds and points:
            accessor["min"] = [round(min(p[k] for p in points), 5) for k in range(width)]
            accessor["max"] = [round(max(p[k] for p in points), 5) for k in range(width)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def indices(self, values: list[int]) -> int:
        payload = struct.pack("<" + "I" * len(values), *values)
        view = self._view(payload, 34963)
        self.accessors.append(
            {
                "bufferView": view,
                "componentType": 5125,
                "count": len(values),
                "type": "SCALAR",
            }
        )
        return len(self.accessors) - 1


def main() -> int:
    with open(os.path.join(SOURCE, "scene.gltf"), "r", encoding="utf-8") as f:
        doc = json.load(f)
    with open(os.path.join(SOURCE, "scene.bin"), "rb") as f:
        binary = f.read()

    matrices = world_matrices(doc)
    materials = doc["materials"]

    # Per target (body or wheel) and material, the triangles to keep.
    buckets: dict[tuple[str, int], list[tuple[float, ...]]] = collections.defaultdict(list)
    counts: collections.Counter[str] = collections.Counter()

    for index, node in enumerate(doc["nodes"]):
        if "mesh" not in node or index not in matrices:
            continue
        matrix = matrices[index]
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            material = materials[primitive["material"]]["name"]
            if material in PLATFORM_MATERIALS:
                continue
            positions = [
                tuple(mat_vec(matrix, p)) for p in read_accessor(doc, binary, primitive["attributes"]["POSITION"])
            ]
            normals = [
                tuple(mat_vec(matrix, n)) for n in read_accessor(doc, binary, primitive["attributes"]["NORMAL"])
            ]
            uv = (
                read_accessor(doc, binary, primitive["attributes"]["TEXCOORD_0"])
                if "TEXCOORD_0" in primitive["attributes"]
                else None
            )
            flat = [i[0] for i in read_accessor(doc, binary, primitive["indices"])]
            component, welded = weld(positions, flat)

            points: dict[int, list[tuple[float, ...]]] = collections.defaultdict(list)
            for vertex, root in enumerate(component):
                points[root].append(positions[vertex])
            target = {root: classify(root, pts, material) for root, pts in points.items()}
            counts.update(target.values())

            # Each triangle carries (position, normal, uv) per corner, already
            # in world space, so the output needs no node transform but the
            # wheel offset.
            for t in range(0, len(flat), 3):
                corners = flat[t : t + 3]
                root = component[corners[0]]
                where = target[root]
                if where == "drop":
                    continue
                triangle = []
                for vertex in corners:
                    triangle.append((positions[vertex], normals[vertex], uv[vertex] if uv else (0.0, 0.0)))
                buckets[(where, primitive["material"])].append(tuple(triangle))

    # --- Geometry ----------------------------------------------------------
    builder = Builder()
    meshes: list[dict] = []
    used_materials: dict[int, int] = {}
    out_materials: list[dict] = []
    order = ["body"] + list(HUBS)

    for where in order:
        primitives = []
        for (target, old_material), triangles in buckets.items():
            if target != where:
                continue
            if old_material not in used_materials:
                source = materials[old_material]
                spec = source.get("extensions", {}).get("KHR_materials_pbrSpecularGlossiness", {})
                metallic, roughness = PBR.get(source["name"], (0.05, 0.5))
                pbr = {
                    "baseColorFactor": spec.get("diffuseFactor", [1, 1, 1, 1]),
                    "metallicFactor": metallic,
                    "roughnessFactor": roughness,
                }
                if "diffuseTexture" in spec:
                    pbr["baseColorTexture"] = dict(spec["diffuseTexture"])
                material = {
                    "name": source["name"],
                    "doubleSided": source.get("doubleSided", False),
                    "pbrMetallicRoughness": pbr,
                }
                for key in ("alphaMode", "alphaCutoff", "emissiveFactor"):
                    if key in source:
                        material[key] = source[key]
                if source["name"] == "illum__env_4_spec_trans" and "diffuseTexture" in spec:
                    material["emissiveTexture"] = dict(spec["diffuseTexture"])
                    material["emissiveFactor"] = [0.55, 0.55, 0.55]
                used_materials[old_material] = len(out_materials)
                out_materials.append(material)
            hub = HUBS.get(where)
            ox, oy, oz = (hub[0], hub[1], hub[2]) if hub else (0.0, 0.0, 0.0)
            cx, cy, cz = CENTER
            vertices: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float]]] = []
            key: dict[tuple, int] = {}
            index_list: list[int] = []
            for triangle in triangles:
                for position, normal, uv in triangle:
                    # Bodies are re-centred on the wheelbase midpoint; wheels are
                    # centred on their hub and placed back by the node.
                    if hub:
                        local = (
                            round(position[0] - ox, 5),
                            round(position[1] - oy, 5),
                            round(position[2] - oz, 5),
                        )
                    else:
                        local = (
                            round(position[0] - cx, 5),
                            round(position[1] - cy, 5),
                            round(position[2] - cz, 5),
                        )
                    stamp = (local, round(normal[0], 4), round(normal[1], 4), round(normal[2], 4), round(uv[0], 4), round(uv[1], 4))
                    if stamp not in key:
                        key[stamp] = len(vertices)
                        vertices.append((local, normal, uv))
                    index_list.append(key[stamp])

            positions_flat: list[float] = []
            normals_flat: list[float] = []
            uvs_flat: list[float] = []
            for position, normal, uv in vertices:
                positions_flat.extend(position)
                normals_flat.extend(normal)
                uvs_flat.extend(uv)
            attribute = {
                "POSITION": builder.floats(positions_flat, 3, bounds=True),
                "NORMAL": builder.floats(normals_flat, 3),
            }
            if uvs_flat:
                attribute["TEXCOORD_0"] = builder.floats(uvs_flat, 2)
            primitives.append(
                {
                    "attributes": attribute,
                    "indices": builder.indices(index_list),
                    "material": used_materials[old_material],
                }
            )
        meshes.append({"name": where, "primitives": primitives})

    nodes = [{"name": "Body", "mesh": 0}]
    for slot, name in enumerate(HUBS, start=1):
        hx, hy, hz = HUBS[name]
        cx, cy, cz = CENTER
        nodes.append(
            {
                "name": name,
                "mesh": slot,
                "translation": [round(hx - cx, 5), round(hy - cy, 5), round(hz - cz, 5)],
            }
        )

    # --- Textures ----------------------------------------------------------
    used_textures = sorted(
        {
            entry["index"]
            for material in out_materials
            for entry in (
                material.get("pbrMetallicRoughness", {}).get("baseColorTexture"),
                material.get("emissiveTexture"),
            )
            if entry
        }
    )
    texture_map = {}
    textures = []
    images = []
    image_map = {}
    for old in used_textures:
        texture = doc["textures"][old]
        source = texture["source"]
        if source not in image_map:
            image_map[source] = len(images)
            images.append(dict(doc["images"][source]))
        texture_map[old] = len(textures)
        textures.append({"sampler": texture.get("sampler", 0), "source": image_map[source]})
    for material in out_materials:
        for holder, key in (
            (material.get("pbrMetallicRoughness", {}), "baseColorTexture"),
            (material, "emissiveTexture"),
        ):
            entry = holder.get(key)
            if entry:
                entry["index"] = texture_map[entry["index"]]

    for image in images:
        path = os.path.join(SOURCE, image.pop("uri"))
        payload, mime = encode_image(path)
        while len(builder.binary) % 4:
            builder.binary.append(0)
        offset = len(builder.binary)
        builder.binary.extend(payload)
        builder.views.append(
            {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
        )
        image["bufferView"] = len(builder.views) - 1
        image["mimeType"] = mime
    samplers = doc.get("samplers", [])

    gltf = {
        "asset": doc["asset"],
        "scene": 0,
        "scenes": [{"name": "i20 N Rally2", "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": meshes,
        "materials": out_materials,
        "textures": textures,
        "samplers": samplers,
        "images": images,
        "accessors": builder.accessors,
        "bufferViews": builder.views,
        "buffers": [{"byteLength": len(builder.binary)}],
    }

    while len(builder.binary) % 4:
        builder.binary.append(0)
    gltf["buffers"][0]["byteLength"] = len(builder.binary)

    payload = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    while len(payload) % 4:
        payload += b" "
    total = 12 + 8 + len(payload) + 8 + len(builder.binary)
    with open(OUTPUT, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(payload), 0x4E4F534A))
        f.write(payload)
        f.write(struct.pack("<II", len(builder.binary), 0x004E4942))
        f.write(builder.binary)

    print(f"{OUTPUT}: {total / 1e6:.2f} MB, {len(out_materials)} materials, {len(images)} textures")
    print("triangles by target:", dict(counts))
    print("nodes:", [node["name"] for node in nodes])
    return 0


if __name__ == "__main__":
    sys.exit(main())
