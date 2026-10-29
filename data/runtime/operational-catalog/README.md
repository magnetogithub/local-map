# Operational catalog runtime inputs

`current.json` pins the current mixed-world catalog's artifact index by hash and
byte length. Its payload is in
`data/derived/prompt19/mixed-world-v2-416fa2c3b263ab7a13be/`.
The loader verifies each requested asset and fails closed if one is missing.

Use `git lfs pull` after cloning to obtain the immutable joined input snapshots.
`npm run data:korea` prepares the KOR ADM2/PRK ADM2 joint arrangement;
`npm run data:world` packages it with the preserved coarse inputs for other countries.
Existing outputs are verified rather than overwritten, and no grid cells are
created. Old catalog sessions and caches are not migrated.
Their approval records remain historical evidence under `reports/prompt15/`.
