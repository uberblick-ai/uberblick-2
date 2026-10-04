#!/usr/bin/env python3
"""Scan every shipped image layer, including files removed by later layers."""

import json
import re
import sys
import tarfile


FORBIDDEN = re.compile(
    r"(^|/)(\.env(?:\.[^/]*)?|\.?fnox\.toml|\.?mise\.local\.toml)(/|$)"
    r"|\.(sqlite(?:3)?|db)([-.][^/]*)?($|/)"
)


def check(archive):
    with tarfile.open(archive) as saved:
        manifest = json.load(saved.extractfile("manifest.json"))
        for entry in manifest:
            for layer_name in entry["Layers"]:
                with tarfile.open(fileobj=saved.extractfile(layer_name), mode="r:*") as layer:
                    for member in layer:
                        # Keep a leading dot on dotfiles; lstrip would conceal
                        # .env at a layer root.
                        path = member.name.removeprefix("./").lstrip("/")
                        if FORBIDDEN.search(path):
                            raise ValueError(f"forbidden file in shipped image layer: {path}")
                        if path == "app/packages" or path.startswith("app/packages/"):
                            raise ValueError("repository checkout in shipped image layer")


if __name__ == "__main__":
    try:
        check(sys.argv[1])
    except (ValueError, KeyError, tarfile.TarError) as error:
        sys.exit(f"check-hub-image: {error}")
    print("check-hub-image: all shipped layers contain no forbidden files or checkout")
