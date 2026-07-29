# Peek maker notes from INSV trailer (Windows-friendly)
from pathlib import Path
import struct
import json

def peek(path):
    path = Path(path)
    with path.open("rb") as fin:
        fin.seek(-(32 + 42 + 4), 2)
        buf = fin.read(38 + 4)
        trailer_len = struct.unpack("<38xL", buf)[0]
        offset = -78
        found = []
        while offset > -min(trailer_len, 5_000_000):
            fin.seek(offset, 2)
            hdr = fin.read(6)
            if len(hdr) < 6:
                break
            rid, rsize = struct.unpack("<HL", hdr)
            if rsize > trailer_len or rsize < 0:
                break
            if rid == 0x101 and rsize < 100_000:
                fin.seek(offset - rsize, 2)
                data = fin.read(rsize)
                text = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
                found.append({"id": hex(rid), "size": rsize, "ascii_preview": text[:500]})
            offset = offset - rsize - 6
            if len(found) >= 1:
                break
        fin.seek(-32, 2)
        magic = fin.read(32).hex()
    return {"file": str(path.name), "trailer_len": trailer_len, "magic": magic, "maker_notes": found}

paths = [
    r"D:\ai\ai-stack\data\insta360\inbox\VID_20181002_024424_00_009.insv",
    r"D:\ai\ai-stack\data\insta360\inbox\VID_20181002_030901_00_010.insv",
    r"D:\ai\ai-stack\data\insta360\inbox\VID_20181002_033037_00_011.insv",
]
out = [peek(p) for p in paths]
dest = Path(r"D:\ai\ai-stack\data\insta360\work\direction-experiments\e3-maker-notes.json")
dest.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
print(json.dumps(out, indent=2)[:2500])
print("wrote", dest)
