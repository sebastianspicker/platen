import { PDF_ADVANCED_SEARCH_PROFILE } from '../../host/pdf-advanced-search-contract.mjs';

export async function runAdvancedSearchCommand(application, command, document, stdout, signal, runtime) {
  runtime.cancelled(signal); if (runtime.canonicalOutputTarget) await runtime.canonicalOutputTarget(command.output);
  const result = await application.advancedSearch.search(document.id, { query: command.query, mode: command.mode, caseSensitive: command.caseSensitive, wholeWord: command.wholeWord, context: command.context, maxResults: command.maxResults }, { sourceSha256: document.sha256, signal });
  runtime.cancelled(signal); const output = { ...result, profile: PDF_ADVANCED_SEARCH_PROFILE, sourceSha256: document.sha256, localOnly: true };
  await runtime.writeExclusive(command.output, `${JSON.stringify(output, null, 2)}\n`, signal); await runtime.emit(stdout, { profile: output.profile, sourceSha256: output.sourceSha256, totalMatches: output.totalMatches, retainedMatches: output.matches.length, truncated: output.truncated, localOnly: true });
}
