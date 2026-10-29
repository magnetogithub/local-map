# Map data and font attribution

Map geometry and names are derived from Natural Earth Cultural Vectors: Admin 0 Countries 1:50m, Admin 0 Countries 1:10m, Admin 0 Label Points 1:10m, Admin 1 States and Provinces 1:10m, and Populated Places 1:10m. Natural Earth data is public domain: https://www.naturalearthdata.com/about/terms-of-use/

The checked-in snapshots originate from the official `natural-earth-vector` repository. `scripts/prepare-map-data.mjs` normalizes identifiers, validates every Admin 1 parent, separates playable states from technical map units, and derives label baselines. Political boundaries follow the source representation; Pax Local adds no independent territorial claims.

MapLibre glyph PBF files use Open Sans Regular from OpenMapTiles fonts. Open Sans and the local Noto Sans CJK KR font are distributed under the SIL Open Font License 1.1. Noto source: https://github.com/notofonts/noto-cjk

The build-time geometry cleanup preserves closed rings and minimum coordinate counts. It does not claim full topological repair or legal boundary accuracy.

Current Korean detail uses geoBoundaries gbOpen KOR ADM2, revision `9469f09592ced973a3448cf66b6100b741b64c0d`, representing 2020. The dataset credits geoBoundaries and Thomas Brinkhoff / City Population and designates CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/); geoBoundaries distribution is CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Original metadata, citations, license investigation and all 228 actual features (metadata reports 229) are retained in `data/raw/prompt19/KOR/geoboundaries-adm2-2020-9469f095/` and `data/source-locks/prompt19/KOR-ADM2-2020.json`.

The previous KOR ADM3 2018 inputs from KoStat/SGIS and Justin Meyers remain as historical source evidence: KOGL Type 1 (https://www.kogl.or.kr/info/license.do) and geoBoundaries CC BY 4.0, under `data/raw/prompt19/KOR/geoboundaries-9469f095/` and `data/source-locks/prompt19/KOR.json`.

North Korean detail uses geoBoundaries gbOpen PRK ADM2, PRK-ADM2-82179303, revision `9469f09`: World Food Programme and OCHA ROAP, distributed under CC BY 3.0 IGO (https://creativecommons.org/licenses/by/3.0/igo/). Original distribution: https://data.humdata.org/dataset/dpr-korea-administrative-boundaries. The gbOpen 2019 and related humanitarian 2013 metadata conflict; the 2023 build date is not an effective or publication date. Records are in `data/source-locks/prompt19/PRK.json`.

Changes: properties normalized; actual source, fixed project country envelopes and coarse parent boundaries jointly noded. Current fine assignments require original interior membership; source holes and unmatched faces are not assigned by boundary contact or inferred continuation. Original inputs remain unchanged. Source-free fixed-envelope land retains explicit coarse provenance (643 KOR and 488 PRK cells), without an ADM2 identity. The previous contact-based arrangement remains historical evidence. These datasets are not a certification of exact boundaries on 2020-01-01.
