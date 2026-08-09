export const CLI_HELP = `Platen local CLI
Usage:
  npm run cli -- engines [--output FILE]
  npm run cli -- inspect INPUT.pdf [--structure] [--tag-text] [--output FILE] | fast-web-view INPUT.pdf --output OUTPUT.pdf
  npm run cli -- accessibility-review INPUT.pdf --output REPORT.json
  npm run cli -- accessibility-metadata INPUT.pdf --language BCP47 --title TITLE --output OUTPUT.pdf
  npm run cli -- signature-review INPUT.pdf --output REPORT.json
  npm run cli -- compare-content PRIMARY.pdf SECONDARY.pdf [--format json|csv] --output REPORT
  npm run cli -- create-blank [--pages N] --output OUTPUT.pdf
  npm run cli -- convert-local INPUT.png --output OUTPUT.pdf
  npm run cli -- convert-office-local INPUT.odt --output OUTPUT.pdf
  npm run cli -- convert-html-local INPUT.html --output OUTPUT.pdf
  npm run cli -- convert-postscript-local INPUT.(ps|eps) --output OUTPUT.pdf
  npm run cli -- create-cad-pdf-local INPUT.dxf --output OUTPUT.pdf
  npm run cli -- print-to-pdf-local INPUT.txt --output OUTPUT.pdf
  npm run cli -- export-structured-local INPUT.pdf --format rtf|html|xml --output OUTPUT.(rtf|html|xml)
  npm run cli -- optimize-compress-local INPUT.pdf --output OUTPUT.pdf
  npm run cli -- export-page-png-local INPUT.pdf --page N --dpi 72|150 --output OUTPUT.png
  npm run cli -- text INPUT.pdf [--format json|text|rtf|html|xml] [--output FILE]
  npm run cli -- export-ooxml INPUT.pdf --format word|excel|powerpoint --output OUTPUT.(docx|xlsx|pptx)
  npm run cli -- ocr INPUT.pdf --output OUTPUT.pdf [--language eng] [--cleanup PRESET] [--segmentation MODE]
  npm run cli -- ocr-layout INPUT.pdf [--page N] [--region X,Y,W,H] [--no-tables] [--format json|html|alto] [--output FILE]
  npm run cli -- ocr-batch INPUT.pdf... --output-dir DIRECTORY [--language eng] [--cleanup PRESET] [--segmentation MODE]
  npm run cli -- watch-ocr INPUT_DIRECTORY --output-dir NEW_DIRECTORY [--once] [--max-files N] [--interval-ms N] [--settle-ms N]
  npm run cli -- prepress INPUT.pdf --operation OPERATION [--profile print-review|archive-review] [--format json|xml] [--layout 2x1|2x2] [--page N] [--dpi N] [--output FILE]
  npm run cli -- layer-defaults INPUT.pdf --changes 0:on,1-3:off --output OUTPUT.pdf
  npm run cli -- text-reflow INPUT.pdf --request REQUEST.json --output OUTPUT.pdf
  npm run cli -- signing-identities
  npm run cli -- certificate-sign INPUT.pdf --certificate-sha256 DIGEST --page N --field-name NAME --consent --output OUTPUT.pdf [--reason TEXT] [--location TEXT] [--contact TEXT] [--placeholder-bytes N]
  npm run cli -- sanitize-hidden-data INPUT.pdf --output OUTPUT.pdf
  npm run cli -- add-checkbox INPUT.pdf --field-name NAME --page N --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- add-radio-group INPUT.pdf --group-name NAME --options OPTIONS.json --output OUTPUT.pdf
  npm run cli -- acroform-text-field INPUT.pdf --page N --field NAME --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- acroform-signature-field INPUT.pdf --page N --field NAME --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- aec-measurement-legend INPUT.pdf --format json|csv --output LEGEND
  npm run cli -- aec-batch-link INPUT.pdf --links LINKS.json --output OUTPUT.pdf
  npm run cli -- scanner-discovery [--output DISCOVERY.json]
  npm run cli -- scan-append PRIMARY.pdf SCAN.(png|jpg|jpeg|tif|tiff) --after-page N --output OUTPUT.pdf
  npm run cli -- acroform-choice INPUT.pdf --field NAME --page N --rect X,Y,W,H --options OPTIONS.json --output OUTPUT.pdf
  npm run cli -- bates-numbering INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf [--start N] [--prefix TEXT] [--suffix TEXT] [--padding N] [--position POS] [--margin N] [--font-size N]
  npm run cli -- page-transition INPUT.pdf --pages 1,3-5 --duration SECONDS --output OUTPUT.pdf
  npm run cli -- tagged-remediation INPUT.pdf --plan PLAN.json --output OUTPUT.pdf
  npm run cli -- insert-jpeg INPUT.pdf IMAGE.jpg --page N --rect X,Y,W,H --output OUTPUT.pdf
  npm run cli -- replace-jpeg INPUT.pdf IMAGE.jpg --page N --resource-name NAME --output OUTPUT.pdf
  npm run cli -- page-labels INPUT.pdf --ranges RANGES.json --output OUTPUT.pdf
  npm run cli -- advanced-search INPUT.pdf --query TEXT [--mode literal|wildcard] [--case-sensitive] [--whole-word] [--context N] [--max-results N] --output RESULTS.json
  npm run cli -- specialist-content INPUT.pdf
  npm run cli -- redact-pages INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf
  npm run cli -- printer-marks INPUT.pdf --pages 1,3-5 --output OUTPUT.pdf
  npm run cli -- page-background INPUT.pdf --pages 1,3-5 --color R,G,B --output OUTPUT.pdf
  npm run cli -- page-watermark INPUT.pdf --pages 1,3-5 --text TEXT --output OUTPUT.pdf
  npm run cli -- snapshot-region INPUT.pdf --page N --region X,Y,W,H [--dpi N] --output OUTPUT.png
  npm run cli -- automation-submit-inspect INPUT.pdf --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit INPUT.pdf --automation-root DIRECTORY (--operation inspect|ocr|output-intent|full-page-redaction | --preset PRESET_ID) [operation options]
  npm run cli -- automation-submit-batch INPUT1.pdf INPUT2.pdf [up to 8 PDFs] --automation-root DIRECTORY --idempotency-key KEY (--operation inspect|ocr|output-intent|full-page-redaction | --preset PRESET_ID) [operation options]
  npm run cli -- automation-submit-ocr INPUT.pdf --automation-root DIRECTORY [--language eng] [--cleanup PRESET] [--segmentation MODE] [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-output-intent INPUT.pdf --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-full-page-redaction INPUT.pdf --pages 1,2,3 --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-submit-sequence INPUT.pdf --sequence SEQUENCE_ID --automation-root DIRECTORY [--idempotency-key KEY] [--output REPORT]
  npm run cli -- automation-run-recipe INPUT.pdf --recipe RECIPE_ID --automation-root DIRECTORY [--repeat 1..4] [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-run-conditional INPUT.pdf --workflow WORKFLOW.json --automation-root DIRECTORY [--idempotency-key KEY] [--output FILE]
  npm run cli -- automation-run --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-status JOB_ID --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-cancel JOB_ID --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-watch-discover INPUT_DIRECTORY --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-schedule-create --schedule-id ID --principal PRINCIPAL --grant-id GRANT --source-id ID --sha256 DIGEST --operation-id ID --operation-kind KIND --first-at EPOCH [--interval-ms MS] [--pages 1,2] --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-schedule-list --principal PRINCIPAL --grant-id GRANT --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-schedule-tick --principal PRINCIPAL --grant-id GRANT [--now EPOCH] --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-schedule-cancel --schedule-id ID --principal PRINCIPAL --grant-id GRANT --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-job-status --principal PRINCIPAL --grant-id GRANT --automation-root DIRECTORY [--output FILE] | automation-processing-report JOB_ID... --principal PRINCIPAL --grant-id GRANT --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-output-list --automation-root DIRECTORY [--output FILE]
  npm run cli -- automation-output-copy OUTPUT_ID --sha256 DIGEST --automation-root DIRECTORY --output OUTPUT.pdf
  npm run cli -- automation-output-delete OUTPUT_ID --sha256 DIGEST --automation-root DIRECTORY [--output FILE]
  npm run cli -- admin.plugin-allowlist --action list --trust-root STATE_DIRECTORY [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action enroll --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID --public-key PEM_FILE --plugin-id ID[,ID...] [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action revoke --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action unrevoke --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID [--output STATE.json]
  npm run cli -- admin.plugin-allowlist --action remove --trust-root STATE_DIRECTORY --publisher-id PUBLISHER_ID --key-id KEY_ID --expected-fingerprint FINGERPRINT [--output STATE.json]
  npm run cli -- admin.plugin-package --action list|install|activate|rollback --plugin-root PACKAGE_DIRECTORY --trust-root STATE_DIRECTORY --policy-root STATE_DIRECTORY [--package PACKAGE.json] [--plugin-id ID] [--version VERSION] [--output STATE.json]
  npm run cli -- admin.policy-configuration --action show --policy-root STATE_DIRECTORY [--output STATE.json]
  npm run cli -- admin.policy-configuration --action set --policy-root STATE_DIRECTORY --plugin-package-administration enabled|disabled --expected-state-sha256 SHA256 [--output STATE.json]
  npm run cli -- admin.audit-telemetry --action list --policy-root STATE_DIRECTORY [--limit 1..100] [--output STATE.json]
All processing is local. Outputs are created exclusively and never overwrite an
existing path. OCR PDFs are rasterized and do not preserve interactive PDF
structure. Prepress output is review evidence, not press or standards
certification. Accessibility review is heuristic and does not validate PDF/UA.
Content comparison covers extracted text tokens only; it does not prove visual,
layout, reading-order, annotation, or object equivalence. Local conversion is
limited to one bounded non-interlaced 8-bit RGB or RGBA PNG and does not certify
pixel or color fidelity. Automation recipes are fixed, allowlisted declarative
descriptors; user-defined code is not accepted. Conditional workflows are bounded
declarative descriptors over verified local document facts and allowlisted operations;
no code/expression engine is accepted.`;
