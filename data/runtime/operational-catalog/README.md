# Operational catalog runtime inputs

`current.json` pins the current mixed-world catalog's artifact index by hash and
byte length. Its payload is in
`data/derived/prompt19/mixed-world-v2-bd5f69398db196fa244d/`.
The loader verifies each requested asset and fails closed if one is missing.

Use `git lfs pull` after cloning to obtain the immutable joined input snapshots.
`npm run data:korea` derives macro regions from the pinned KOR/PRK fine units and verified hierarchy,
reconciles country/coast residual strips as explicit gameplay geometry, and runs independent verification.
`npm run data:world` requires the passing verification report to match the input hashes before
packaging it with the preserved coarse inputs for other countries.
Existing outputs are verified rather than overwritten, and no grid cells are
created. Old catalog sessions and caches are not migrated.
Their approval records remain historical evidence under `reports/prompt15/`.
