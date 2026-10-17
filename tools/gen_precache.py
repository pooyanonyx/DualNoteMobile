"""Write www/precache.json: the list of files the service worker stores for offline use.
Run it again after adding or removing files:  python tools/gen_precache.py"""
import json, os
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")
files = []
for base, _, names in os.walk(root):
    for n in sorted(names):
        rel = os.path.relpath(os.path.join(base, n), root).replace(os.sep, "/")
        if rel in ("sw.js", "precache.json"):
            continue
        files.append(rel)
files.sort()
files.insert(0, "./")
with open(os.path.join(root, "precache.json"), "w") as f:
    json.dump(files, f, indent=0)
print(len(files), "files listed")
