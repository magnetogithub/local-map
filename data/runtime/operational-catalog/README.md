# Operational catalog runtime inputs

`catalog-v3-56fc6c79c216e6bd1a11/` contains byte-preserving deployment copies:

- `final-admission.json`: `reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/final-admission.json`
- `verdict.json`: the same intake's `admitted/verdict.json`
- `delivery-artifact-index.json`: `data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11/artifact-index.json`

The loader maps these physical paths explicitly. The admission's original
`authoritativeVerdict`, verdict candidate, downstream asset roots, and identity
checks retain their logical meaning. The unique delivery index name avoids
tracing historical snapshot indices with the same original path suffix.
Do not serialize or regenerate these copies; preserve the admitted source bytes.
