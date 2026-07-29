#!/usr/bin/env python3
"""Minimal INSV trailer smoke: list record IDs + first accel/gyro samples (Gyroflow-style)."""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def iter_trailer_records(path: Path):
    with path.open("rb") as fin:
        fin.seek(0, 2)
        size = fin.tell()
        # magic 32 bytes at end; trailer length 4 bytes before a 42-byte header region (Gyroflow layout)
        fin.seek(-(32 + 42 + 4), 2)
        buf = fin.read(38 + 4)
        trailer_len = struct.unpack("<38xL", buf)[0]
        offset = -78
        records = []
        while offset > -trailer_len:
            fin.seek(offset, 2)
            hdr = fin.read(2 + 4)
            if len(hdr) < 6:
                break
            rid, rsize = struct.unpack("<HL", hdr)
            data_off = offset - rsize
            fin.seek(data_off, 2)
            data = fin.read(rsize)
            records.append({"id": rid, "id_hex": hex(rid), "size": rsize, "data": data})
            offset = offset - rsize - 6
        return trailer_len, size, records


def parse_imu_0x300(data: bytes, max_samples: int = 5):
    """Record 0x300: repeating 56-byte samples (timecode + 6 doubles) — pitch/yaw/roll convention varies."""
    dlen = 56
    samples = []
    for i in range(0, min(len(data), dlen * max_samples), dlen):
        chunk = data[i : i + dlen]
        if len(chunk) < dlen:
            break
        tm, a0, a1, a2, g0, g1, g2 = struct.unpack("<Q6d", chunk)
        samples.append(
            {
                "t_raw": tm,
                "a": [a0, a1, a2],
                "g": [g0, g1, g2],
            }
        )
    return samples


def gravity_angles(a):
    import math

    ax, ay, az = a
    norm = math.sqrt(ax * ax + ay * ay + az * az) or 1.0
    ax, ay, az = ax / norm, ay / norm, az / norm
    # coarse pitch/roll from gravity (camera frame unknown — comparative only)
    pitch = math.degrees(math.asin(max(-1, min(1, -ax))))  # heuristic
    roll = math.degrees(math.atan2(ay, az))
    return {"pitch_ish": pitch, "roll_ish": roll, "g_norm": norm}


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/insv_trailer_smoke.py <file.insv> [file2.insv ...]")
        sys.exit(1)
    out = []
    for arg in sys.argv[1:]:
        path = Path(arg)
        trailer_len, size, records = iter_trailer_records(path)
        summary = {
            "file": str(path),
            "size_gb": round(size / 1e9, 3),
            "trailer_len": trailer_len,
            "records": [{"id_hex": r["id_hex"], "size": r["size"]} for r in records],
        }
        imu = next((r for r in records if r["id"] == 0x300), None)
        if imu:
            samples = parse_imu_0x300(imu["data"], max_samples=8)
            summary["imu_samples_head"] = samples
            if samples:
                summary["gravity_from_first_accel"] = gravity_angles(samples[0]["a"])
        out.append(summary)
        print(json.dumps(summary, indent=2)[:2000])
        print("---")
    dest = Path(r"D:\ai\ai-stack\data\insta360\work\direction-experiments\e3-trailer-smoke.json")
    dest.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print("wrote", dest)


if __name__ == "__main__":
    main()
