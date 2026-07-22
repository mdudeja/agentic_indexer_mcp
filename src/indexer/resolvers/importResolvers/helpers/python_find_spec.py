import importlib.util
import json
import sys
import sysconfig
import pathlib

stdlib_path = pathlib.Path(sysconfig.get_paths()["stdlib"]).resolve()
purelib_path = pathlib.Path(sysconfig.get_paths()["purelib"]).resolve()
platlib_path = pathlib.Path(sysconfig.get_paths()["platlib"]).resolve()

def classify_path(origin: str) -> str:
    """ This function categorizes a given file path into different types. """
    if origin == "built-in" or origin == "frozen":
        return "builtin"
    
    path = pathlib.Path(origin).resolve()
    if purelib_path in path.parents or platlib_path in path.parents:
        return "package"
    elif stdlib_path in path.parents:
        return "stdlib"
    else:
        return "unresolved"

module_name = sys.argv[1]
spec = importlib.util.find_spec(module_name)

if spec is None:
    result = {
        "ok": False,
        "module_name": module_name,
    }
else:
    if spec.origin is None:
        kind = "package" if spec.submodule_search_locations is not None else "unresolved"
    else:
        kind = classify_path(spec.origin)
    
    result = {
        "ok": True,
        "module_name": module_name,
        "kind": kind,
        "origin": spec.origin,
        "submodule_search_locations": list(spec.submodule_search_locations or []),
        "is_package": spec.submodule_search_locations is not None,
    }

print(json.dumps(result))