# Map data and font attribution

Map geometry and names are derived from Natural Earth Cultural Vectors: Admin 0 Countries 1:50m, Admin 0 Countries 1:10m, Admin 0 Label Points 1:10m, Admin 1 States and Provinces 1:10m, and Populated Places 1:10m. Natural Earth data is public domain: https://www.naturalearthdata.com/about/terms-of-use/

The checked-in snapshots originate from the official `natural-earth-vector` repository. `scripts/prepare-map-data.mjs` normalizes identifiers, validates every Admin 1 parent, separates playable states from technical map units, and derives label baselines. Political boundaries follow the source representation; Pax Local adds no independent territorial claims.

MapLibre glyph PBF files use Open Sans Regular from OpenMapTiles fonts. Open Sans and the local Noto Sans CJK KR font are distributed under the SIL Open Font License 1.1. Noto source: https://github.com/notofonts/noto-cjk

The build-time geometry cleanup preserves closed rings and minimum coordinate counts. It does not claim full topological repair or legal boundary accuracy.
