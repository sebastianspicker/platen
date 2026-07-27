import { searchTextPages } from '../../core/document-analysis.js';
import { transitionApplicationView } from '../../core/ui-actions.js';

export function createViewerStateController({
  state,
  resetLoupe,
  render,
  documentApi,
  urlApi,
}) {
  function setView(view) {
    state.view = transitionApplicationView(state.view, view, () => {
      resetLoupe('The application view changed.');
    });
    state.error = null;
    render();
    documentApi.querySelector('#workspace')?.focus({ preventScroll: true });
  }

  function revokeThumbnails(thumbnails = state.analysis.thumbnails) {
    for (const thumbnail of thumbnails) {
      if (thumbnail?.url) {
        urlApi.revokeObjectURL(thumbnail.url);
      }
    }
  }

  function updateSearchResults() {
    state.searchResults = searchTextPages(state.analysis.textPages, state.searchQuery, {
      caseSensitive: state.searchCaseSensitive,
      wholeWord: state.searchWholeWord,
    });
  }

  return Object.freeze({ setView, revokeThumbnails, updateSearchResults });
}
