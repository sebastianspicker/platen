import {
  exactObject,
  fail,
  nullableString,
  pageNumber,
  point,
  rectangle,
} from './pdfkit-mutation-contract-shared.mjs';

const LOCAL_GOTO_MUTATION_KEYS = new Set(['link']);
const LINE_ANNOTATION_MUTATION_KEYS = new Set(['line']);
const INK_ANNOTATION_MUTATION_KEYS = new Set(['ink']);

export function normalizeLocalGoToMutation(value, sourceInspection) {
  const input = exactObject(value, LOCAL_GOTO_MUTATION_KEYS, 'mutation');
  const link = exactObject(
    input.link,
    new Set(['sourcePage', 'targetPage', 'rect']),
    'mutation.link',
  );
  return Object.freeze({
    mutation: Object.freeze({
      link: Object.freeze({
        sourcePage: pageNumber(
          link.sourcePage,
          sourceInspection.pageCount,
          'mutation.link.sourcePage',
        ),
        targetPage: pageNumber(
          link.targetPage,
          sourceInspection.pageCount,
          'mutation.link.targetPage',
        ),
        rect: rectangle(link.rect, 'mutation.link.rect'),
      }),
    }),
    editCount: 1,
    targeted: false,
    localGoTo: true,
    expectedForm: 'none',
  });
}

export function normalizeLineAnnotationMutation(value, sourceInspection) {
  const input = exactObject(value, LINE_ANNOTATION_MUTATION_KEYS, 'mutation');
  const line = exactObject(
    input.line,
    new Set(['page', 'contents', 'start', 'end']),
    'mutation.line',
  );
  const contents = nullableString(line.contents, 'mutation.line.contents');
  if (contents === null || Buffer.byteLength(contents, 'utf8') === 0) {
    fail('INVALID_PDFKIT_MUTATION', 'mutation.line.contents must contain bounded text.');
  }
  const start = point(line.start, 'mutation.line.start');
  const end = point(line.end, 'mutation.line.end');
  if (start.x === end.x && start.y === end.y) {
    fail('INVALID_PDFKIT_MUTATION', 'mutation.line endpoints must be distinct.');
  }
  return Object.freeze({
    mutation: Object.freeze({
      line: Object.freeze({
        page: pageNumber(line.page, sourceInspection.pageCount, 'mutation.line.page'),
        contents,
        start,
        end,
      }),
    }),
    editCount: 1,
    targeted: false,
    localGoTo: false,
    lineAnnotation: true,
    expectedForm: 'none',
  });
}

export function normalizeInkAnnotationMutation(value, sourceInspection) {
  const input = exactObject(value, INK_ANNOTATION_MUTATION_KEYS, 'mutation');
  const ink = exactObject(
    input.ink,
    new Set(['page', 'contents', 'points']),
    'mutation.ink',
  );
  const contents = nullableString(ink.contents, 'mutation.ink.contents');
  if (contents === null || Buffer.byteLength(contents, 'utf8') === 0) {
    fail('INVALID_PDFKIT_MUTATION', 'mutation.ink.contents must contain bounded text.');
  }
  if (!Array.isArray(ink.points) || ink.points.length < 2 || ink.points.length > 32) {
    fail('INVALID_PDFKIT_MUTATION', 'mutation.ink.points must contain 2 through 32 points.');
  }
  const points = Object.freeze(ink.points.map(
    (entry, index) => point(entry, `mutation.ink.points[${index}]`),
  ));
  if (points.some((entry, index) => index > 0
    && entry.x === points[index - 1].x && entry.y === points[index - 1].y)) {
    fail(
      'INVALID_PDFKIT_MUTATION',
      'mutation.ink.points must not contain consecutive duplicate points.',
    );
  }
  return Object.freeze({
    mutation: Object.freeze({
      ink: Object.freeze({
        page: pageNumber(ink.page, sourceInspection.pageCount, 'mutation.ink.page'),
        contents,
        points,
      }),
    }),
    editCount: 1,
    targeted: false,
    localGoTo: false,
    lineAnnotation: false,
    inkAnnotation: true,
    expectedForm: 'none',
  });
}
